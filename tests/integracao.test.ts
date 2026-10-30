// Teste de ponta a ponta com Postgres de verdade: painel → conta simulada → estratégia →
// webhook → ordem → saldo e posição. A cotação da exchange é fixa (sem internet).
//
// Roda só com TEST_DATABASE_URL apontando para um banco VAZIO, que o teste apaga e recria:
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/bot_teste npm test

import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_BANCO = process.env.TEST_DATABASE_URL;
const PRECO = 50_000;
let precoAgora = PRECO; // o teste do piloto derruba o preço para disparar o stop

// velas que o teste da varredura do piloto põe no ETH/BRL (uma virada para alta)
let velasEth: { t: number; abre: number; max: number; min: number; fecha: number; volume: number }[] | null = null;
const serieAlta = () =>
  Array.from({ length: 300 }, (_, i) => {
    const f = PRECO * (0.8 + i / 1000);
    return { t: Date.UTC(2026, 0, 1) + i * 86_400_000, abre: f, max: f * 1.01, min: f * 0.99, fecha: f, volume: 1000 };
  });

vi.mock('../src/brokers/ccxt.js', () => ({
  exchangesSuportadas: () => ['binance'],
  exchangePublica: async () => ({ markets: { 'BTC/USDT': {}, 'BTC/BRL': {}, 'ETH/BRL': {} } }),
  cotacaoPublica: async () => precoAgora,
  velasDiarias: async () => serieAlta(),
  velas: async (_ex: string, simbolo: string, tempo: string) => (simbolo === 'ETH/BRL' && tempo !== '1d' && velasEth ? velasEth : serieAlta()),
  paresDaMoeda: async () => [{ simbolo: 'BTC/BRL', volume: 9e6 }, { simbolo: 'ETH/BRL', volume: 5e6 }],
  MS_DA_VELA: { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 },
  CorretoraCcxt: class {
    constructor() {
      throw new Error('o teste não fala com exchange real');
    }
  },
}));

describe.skipIf(!URL_BANCO)('fluxo completo em simulação', () => {
  let servidor: Server;
  let base: string;
  let cookie = '';
  let token = '';
  let db: typeof import('../src/db.js');

  // IA falsa no formato da API da OpenAI, para testar o conector compatível de ponta a ponta
  let iaFalsa: Server;
  let urlIa = '';
  let respostaIa = '{"decisao":"vetar","confianca":0.9,"motivo":"teste"}';
  const pedidosIa: { auth?: string; corpo: { messages: { content: string }[] } }[] = [];
  let kronosFalso: Server;
  let chamadasKronos = 0;
  // Yahoo falso (cotações da B3 do assistente) e Telegram falso (avisos)
  let yahooFalso: Server;
  let telegramFalso: Server;
  const mensagensTelegram: { metodo: string; corpo: Record<string, unknown> }[] = [];

  const painel = async (metodo: string, caminho: string, corpo?: unknown) => {
    const r = await fetch(base + '/api' + caminho, {
      method: metodo,
      headers: { 'content-type': 'application/json', 'x-painel': '1', cookie },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    return { status: r.status, corpo: (await r.json()) as Record<string, unknown> };
  };

  const sinal = async (corpo: unknown, t = token) => {
    const r = await fetch(`${base}/webhook/${t}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    });
    return { status: r.status, corpo: (await r.json()) as Record<string, unknown> };
  };

  const saldo = async (moeda: string) =>
    (await db.query<{ quantidade: number }>('select quantidade from saldos_simulados where moeda = $1', [moeda]))[0]?.quantidade ?? 0;

  beforeAll(async () => {
    // Kronos falso: devolve sempre a mesma previsão
    kronosFalso = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/saude') return void res.end('{"ok":true,"modelo":"falso"}');
      req.resume();
      req.on('end', () => {
        chamadasKronos++;
        res.end(JSON.stringify({
          modelo: 'falso', horizonte: 5, caminhos: 16, ultimo: 100, datas: ['a', 'b', 'c', 'd', 'e'],
          mediana: [101, 102, 103, 103, 104], p10: [99, 98, 97, 96, 95], p90: [103, 105, 107, 109, 111],
          retorno_mediano_pct: 4, retorno_p10_pct: -5, retorno_p90_pct: 11, prob_alta: 0.72, ms: 5,
        }));
      });
    }).listen(0);
    process.env.KRONOS_URL = `http://127.0.0.1:${(kronosFalso.address() as AddressInfo).port}`;
    yahooFalso = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (!String(req.url).includes('/PETR4.SA')) {
        res.statusCode = 404;
        return void res.end('{"chart":{"result":null,"error":{"description":"No data found"}}}');
      }
      const t0 = Date.UTC(2026, 0, 2, 13);
      const n = 250;
      res.end(JSON.stringify({ chart: { result: [{
        meta: { regularMarketPrice: 38.2 },
        timestamp: Array.from({ length: n }, (_, i) => t0 / 1000 + i * 86_400),
        indicators: { quote: [{
          open: Array.from({ length: n }, (_, i) => 30 + i * 0.03),
          high: Array.from({ length: n }, (_, i) => 30.5 + i * 0.03),
          low: Array.from({ length: n }, (_, i) => 29.5 + i * 0.03),
          close: Array.from({ length: n }, (_, i) => (i === 10 ? null : 30.1 + i * 0.03)),
          volume: Array.from({ length: n }, () => 30_000_000),
        }] },
      }], error: null } }));
    }).listen(0);
    telegramFalso = createServer((req, res) => {
      let corpo = '';
      req.on('data', (p) => (corpo += p));
      req.on('end', () => {
        const metodo = String(req.url).split('/').pop()!;
        mensagensTelegram.push({ metodo, corpo: JSON.parse(corpo || '{}') });
        res.setHeader('content-type', 'application/json');
        const result = metodo === 'getMe' ? { username: 'meu_bot_teste' } : metodo === 'getUpdates' ? [] : { message_id: 500 + mensagensTelegram.length };
        res.end(JSON.stringify({ ok: true, result }));
      });
    }).listen(0);
    process.env.B3_COTACOES_URL = `http://127.0.0.1:${(yahooFalso.address() as AddressInfo).port}`;
    process.env.TELEGRAM_API_URL = `http://127.0.0.1:${(telegramFalso.address() as AddressInfo).port}`;
    Object.assign(process.env, {
      DATABASE_URL: URL_BANCO,
      BOT_SESSION_SECRET: 'segredo-de-teste',
      BOT_ENCRYPTION_KEY: 'chave-de-teste',
      BOT_PUBLIC_URL: 'http://teste',
      LOG_LEVEL: 'silent',
    });
    db = await import('../src/db.js');
    await db.query('drop schema public cascade; create schema public;');
    await db.migrar();
    const { hashSenha } = await import('../src/auth.js');
    await db.query('insert into usuarios (email, senha_hash) values ($1, $2)', ['dono@teste.com', await hashSenha('senha-boa')]);
    iaFalsa = createServer((req, res) => {
      let corpo = '';
      req.on('data', (p) => (corpo += p));
      req.on('end', () => {
        pedidosIa.push({ auth: req.headers.authorization, corpo: JSON.parse(corpo) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: respostaIa } }] }));
      });
    }).listen(0);
    urlIa = `http://127.0.0.1:${(iaFalsa.address() as AddressInfo).port}/v1`;
    const { criarApp } = await import('../src/app.js');
    servidor = criarApp().listen(0);
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    servidor?.close();
    iaFalsa?.close();
    kronosFalso?.close();
    yahooFalso?.close();
    telegramFalso?.close();
    await db?.pool.end();
  });

  it('painel exige login e o cabeçalho do painel', async () => {
    expect((await painel('GET', '/resumo')).status).toBe(401);
    const semCabecalho = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"dono@teste.com","senha":"senha-boa"}',
    });
    expect(semCabecalho.status).toBe(403);
    expect((await painel('POST', '/login', { email: 'dono@teste.com', senha: 'errada' })).status).toBe(401);
  });

  it('login', async () => {
    const r = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-painel': '1' },
      body: '{"email":"dono@teste.com","senha":"senha-boa"}',
    });
    expect(r.status).toBe(200);
    cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    expect((await painel('GET', '/sessao')).corpo).toEqual({ email: 'dono@teste.com' });
  });

  it('cria conta simulada e estratégia; conta real sem chave é recusada', async () => {
    expect((await painel('POST', '/contas', { nome: 'Real', exchange: 'binance', modo: 'real' })).status).toBe(400);
    const conta = await painel('POST', '/contas', {
      nome: 'Binance simulada',
      exchange: 'binance',
      saldo_inicial: { moeda: 'USDT', quantidade: 1000 },
    });
    expect(conta.status).toBe(201);
    expect(conta.corpo).toMatchObject({ modo: 'simulacao', tem_chave: false });

    const contaId = conta.corpo.id as number;
    expect((await painel('POST', '/estrategias', { nome: 'x', conta_id: contaId, simbolo: 'BTC/USDT', valor_ordem: 300, limite_por_ordem: 200, limite_diario: 500 })).status).toBe(400);
    expect((await painel('POST', '/estrategias', { nome: 'x', conta_id: contaId, simbolo: 'BTC/USDT', valor_ordem: 100, limite_por_ordem: 200, limite_diario: 500, real: true })).status).toBe(400);

    const est = await painel('POST', '/estrategias', {
      nome: 'TradingView BTC',
      conta_id: contaId,
      simbolo: 'BTC/USDT',
      ativa: true,
      valor_ordem: 100,
      limite_por_ordem: 200,
      limite_diario: 250,
      intervalo_min_seg: 3600,
    });
    expect(est.status).toBe(201);
    token = String(est.corpo.webhook).split('/webhook/')[1]!;
    expect(token.length).toBeGreaterThan(30);
    const lista = await painel('GET', '/estrategias');
    expect(JSON.stringify(lista.corpo)).not.toContain('token_hash');
  });

  it('token errado dá 404 e nada é gravado', async () => {
    expect((await sinal({ acao: 'comprar' }, 'x'.repeat(43))).status).toBe(404);
    expect(await db.query('select 1 from sinais')).toHaveLength(0);
  });

  it('compra em simulação: ordem, saldo e posição', async () => {
    const r = await sinal('{"acao":"buy","simbolo":"BINANCE:BTCUSDT","id":"a1"}');
    expect(r).toMatchObject({ status: 200, corpo: { situacao: 'executado' } });
    expect(await saldo('USDT')).toBeCloseTo(900);
    expect(await saldo('BTC')).toBeCloseTo(99.9 / PRECO, 10);
    const [pos] = await db.query<{ quantidade: number; custo_total: number }>('select * from posicoes');
    expect(pos!.custo_total).toBeCloseTo(100);
  });

  it('mesmo id é ignorado; intervalo mínimo segura a segunda compra', async () => {
    expect((await sinal({ acao: 'comprar', id: 'a1' })).corpo).toMatchObject({ situacao: 'ignorado' });
    expect((await sinal({ acao: 'comprar', id: 'a2' })).corpo).toMatchObject({ situacao: 'rejeitado' });
    expect(await saldo('USDT')).toBeCloseTo(900);
  });

  it('JSON quebrado é rejeitado e registrado', async () => {
    expect((await sinal('acao=comprar')).status).toBe(400);
    const [ultimo] = await db.query<{ situacao: string }>('select situacao from sinais order by id desc limit 1');
    expect(ultimo!.situacao).toBe('rejeitado');
  });

  it('zerar vende tudo, passando por cima do intervalo', async () => {
    const r = await sinal({ acao: 'zerar' });
    expect(r.corpo).toMatchObject({ situacao: 'executado' });
    expect(await saldo('BTC')).toBe(0);
    // 99.9 de BTC vendido a 50.000 menos 0,1% de taxa
    expect(await saldo('USDT')).toBeCloseTo(900 + 99.9 * 0.999, 6);
    const [pos] = await db.query<{ quantidade: number; custo_total: number }>('select * from posicoes');
    expect(pos).toMatchObject({ quantidade: 0, custo_total: 0 });
  });

  it('dois sinais ao mesmo tempo não furam o limite diário', async () => {
    await db.query('update estrategias set intervalo_min_seg = 0');
    // já comprou 100 hoje; limite 250: cabe só mais uma de 100
    const [a, b] = await Promise.all([sinal({ acao: 'comprar', id: 'c1' }), sinal({ acao: 'comprar', id: 'c2' })]);
    const situacoes = [a.corpo.situacao, b.corpo.situacao].sort();
    expect(situacoes).toEqual(['executado', 'rejeitado']);
    const [{ total }] = (await db.query<{ total: number }>(
      `select sum(custo) as total from ordens where lado = 'compra' and situacao = 'executada'`,
    )) as [{ total: number }];
    expect(total).toBeCloseTo(200);
  });

  it('parada geral bloqueia', async () => {
    expect((await painel('POST', '/parada', { ligada: true })).corpo).toEqual({ parada_geral: true });
    expect((await sinal({ acao: 'zerar' })).corpo).toMatchObject({ situacao: 'rejeitado' });
    await painel('POST', '/parada', { ligada: false });
    expect((await sinal({ acao: 'zerar' })).corpo).toMatchObject({ situacao: 'executado' });
  });

  it('conector de IA: https obrigatório fora da rede interna e a chave nunca volta', async () => {
    expect((await painel('POST', '/ias', { nome: 'x', provedor: 'openai', url_base: 'http://exemplo.com/v1', modelo: 'm' })).status).toBe(400);
    expect((await painel('POST', '/ias', { nome: 'x', provedor: 'anthropic', modelo: 'claude-haiku-5-5' })).status).toBe(400);
    const c = await painel('POST', '/ias', { nome: 'IA falsa', provedor: 'openai', url_base: urlIa, modelo: 'falso-1', api_key: 'sk-segredo-de-teste-123' });
    expect(c.status).toBe(201);
    expect(c.corpo).toMatchObject({ tem_chave: true });
    const lista = await painel('GET', '/ias');
    expect(JSON.stringify(lista.corpo)).not.toContain('segredo');
    expect(JSON.stringify(lista.corpo)).not.toContain('api_key_cifrada');
  });

  it('IA obrigatória barra a compra; o parecer fica gravado no sinal', async () => {
    await db.query('update estrategias set limite_diario = 10000');
    const [est] = await db.query<{ id: number }>('select id from estrategias');
    expect((await painel('PATCH', `/estrategias/${est!.id}`, { ia_modo: 'obrigatorio' })).status).toBe(200);
    // PATCH só muda o que veio: a estratégia continua ativa e com os mesmos limites
    expect((await db.query('select ativa, limite_diario from estrategias'))[0]).toEqual({ ativa: true, limite_diario: 10000 });
    respostaIa = '```json\n{"decisao":"vetar","confianca":0.9,"motivo":"tendência de baixa"}\n```';
    const r = await sinal({ acao: 'comprar', id: 'ia1' });
    expect(r.corpo).toMatchObject({ situacao: 'rejeitado' });
    expect(String(r.corpo.motivo)).toMatch(/^IA barrou/);
    expect(pedidosIa.at(-1)!.auth).toBe('Bearer sk-segredo-de-teste-123');
    expect(pedidosIa.at(-1)!.corpo.messages[1]!.content).toContain('BTC/USDT');
    const sinais = await painel('GET', '/sinais?limite=1');
    expect((sinais.corpo as unknown as { pareceres: unknown[] }[])[0]!.pareceres).toMatchObject([
      { conector: 'IA falsa', decisao: 'vetar', confianca: 0.9, motivo: 'tendência de baixa' },
    ]);
  });

  it('IA aprova com confiança suficiente: a ordem sai; zerar não consulta IA', async () => {
    respostaIa = '{"decisao":"aprovar","confianca":0.4,"motivo":"fraco"}';
    expect((await sinal({ acao: 'comprar', id: 'ia2' })).corpo).toMatchObject({ situacao: 'rejeitado' });
    respostaIa = '{"decisao":"aprovar","confianca":0.85,"motivo":"ok"}';
    expect((await sinal({ acao: 'comprar', id: 'ia3' })).corpo).toMatchObject({ situacao: 'executado' });
    const antes = pedidosIa.length;
    expect((await sinal({ acao: 'zerar', id: 'ia4' })).corpo).toMatchObject({ situacao: 'executado' });
    expect(pedidosIa.length).toBe(antes);
  });

  it('IA que não responde JSON conta como falha e, na política padrão, reprova', async () => {
    respostaIa = 'não sei';
    const r = await sinal({ acao: 'comprar', id: 'ia5' });
    expect(r.corpo).toMatchObject({ situacao: 'rejeitado' });
    expect(String(r.corpo.motivo)).toContain('1 falharam');
  });

  it('testar e perguntar a todas', async () => {
    respostaIa = '{"decisao":"aprovar","confianca":0.7,"motivo":"conexão ok"}';
    const [c] = await db.query<{ id: number }>('select id from conectores_ia');
    expect((await painel('POST', `/ias/${c!.id}/testar`)).corpo).toMatchObject({ ok: true, parecer: { decisao: 'aprovar' } });
    respostaIa = 'BTC está volátil.';
    const r = await painel('POST', '/ias/perguntar', { pergunta: 'Como está o BTC?' });
    expect(r.corpo).toMatchObject([{ ok: true, texto: 'BTC está volátil.' }]);
  });

  it('análise com 5 agentes: roda em segundo plano, dá a nota e trava a compra abaixo do mínimo', async () => {
    const subnotas = [14, 14, 14, 14, 14].map((nota, i) => ({ nome: `s${i}`, nota }));
    respostaIa = JSON.stringify({ subnotas, sinal: 'Alta', resumo: 'tendência de alta', pontos: ['p'], niveis: { entrada_min: 1, entrada_max: 2, stop: 0.5, alvo1: 3, alvo2: 4 } });
    const pedido = await painel('POST', '/analises', { simbolo: 'btc/usdt', exchange: 'binance' });
    expect(pedido.status).toBe(202);
    let a: Record<string, unknown> = {};
    for (let i = 0; i < 50 && a.situacao !== 'pronta'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      a = (await painel('GET', `/analises/${pedido.corpo.id}`)).corpo;
    }
    expect(a).toMatchObject({ situacao: 'pronta', simbolo: 'BTC/USDT', nota: 70, conceito: 'A', sinal: 'Compra' });
    expect(Object.keys(a.agentes as object).sort()).toEqual(['fundamental', 'risco', 'sentimento', 'tecnico', 'tese']);
    expect((a.dados as { media_200d: number }).media_200d).toBeGreaterThan(0);
    expect((a.dados as { previsao_kronos: { chance_de_terminar_acima: number } }).previsao_kronos.chance_de_terminar_acima).toBe(0.72);
    // os agentes recebem os indicadores calculados das velas
    expect(pedidosIa.at(-1)!.corpo.messages[1]!.content).toContain('ifr_14');

    const [est] = await db.query<{ id: number }>('select id from estrategias');
    await painel('PATCH', `/estrategias/${est!.id}`, { ia_modo: 'desligado', analise_nota_min: 75 });
    const r = await sinal({ acao: 'comprar', id: 'an1' });
    expect(r.corpo).toMatchObject({ situacao: 'rejeitado' });
    expect(String(r.corpo.motivo)).toMatch(/nota da análise 70 abaixo do mínimo 75/);
    await painel('PATCH', `/estrategias/${est!.id}`, { analise_nota_min: 60 });
    expect((await sinal({ acao: 'comprar', id: 'an2' })).corpo).toMatchObject({ situacao: 'executado' });
  });

  it('agente em etapas: cada etapa na sua IA, a decisão lê os relatórios e pode barrar', async () => {
    const [c] = await db.query<{ id: number }>('select id from conectores_ia');
    const [est] = await db.query<{ id: number }>('select id from estrategias');
    expect((await painel('PUT', '/agente', { etapas: { pesquisa: { conector_id: 9999 } } })).status).toBe(400);
    await painel('PUT', '/agente', { etapas: { pesquisa: { conector_id: c!.id }, tecnica: { conector_id: c!.id }, decisao: { conector_id: c!.id } } });
    expect((await painel('GET', '/agente')).corpo).toMatchObject({ pronto: true });
    await painel('PATCH', `/estrategias/${est!.id}`, { ia_modo: 'obrigatorio', ia_tipo: 'agente', analise_nota_min: null });

    respostaIa = '{"vies":"contra","nota":20,"resumo":"queda forte","pontos":["abaixo da média 200"],"decisao":"vetar","confianca":0.9,"motivo":"a técnica foi contra"}';
    const antes = pedidosIa.length;
    const r = await sinal({ acao: 'comprar', id: 'ag1' });
    expect(r.corpo).toMatchObject({ situacao: 'rejeitado' });
    // duas etapas ligadas + a decisão
    expect(pedidosIa.length - antes).toBe(3);
    expect(pedidosIa.at(-1)!.corpo.messages[1]!.content).toContain('## Análise técnica');
    const [exec] = await db.query<{ origem: string; decisao: string; etapas: Record<string, unknown>; sinal_id: number }>('select * from agente_execucoes order by id');
    expect(exec).toMatchObject({ origem: 'sinal', decisao: 'vetar' });
    expect(Object.keys(exec!.etapas).sort()).toEqual(['pesquisa', 'tecnica']);
    const [s1] = (await painel('GET', '/sinais?limite=1')).corpo as unknown as { agente: { decisao: string } }[];
    expect(s1!.agente.decisao).toBe('vetar');

    respostaIa = '{"vies":"a_favor","nota":80,"resumo":"ok","pontos":[],"decisao":"aprovar","confianca":0.85,"motivo":"tudo a favor"}';
    expect((await sinal({ acao: 'comprar', id: 'ag2' })).corpo).toMatchObject({ situacao: 'executado' });
  });

  it('previsão do Kronos entra como etapa e a decisão lê o relatório dela', async () => {
    const [c] = await db.query<{ id: number }>('select id from conectores_ia');
    await painel('PUT', '/agente', { etapas: { previsao: { ligada: true }, decisao: { conector_id: c!.id } } });
    expect((await painel('GET', '/agente')).corpo).toMatchObject({ kronos: { ok: true, modelo: 'falso' } });
    const antes = chamadasKronos;
    expect((await sinal({ acao: 'comprar', id: 'kr1' })).corpo).toMatchObject({ situacao: 'executado' });
    expect(chamadasKronos).toBe(antes + 1);
    expect(pedidosIa.at(-1)!.corpo.messages[1]!.content).toContain('## Previsão (Kronos) (Kronos): a_favor, nota 72/100');
    const [ultima] = await db.query<{ etapas: Record<string, { ok: boolean }> }>('select etapas from agente_execucoes order by id desc limit 1');
    expect(Object.keys(ultima!.etapas)).toEqual(['previsao']);
  });

  it('teste do agente pelo painel roda em segundo plano', async () => {
    const t = await painel('POST', '/agente/testar', { simbolo: 'btc/usdt', exchange: 'binance' });
    expect(t.status).toBe(202);
    let e: Record<string, unknown> = {};
    for (let i = 0; i < 50 && e.situacao !== 'pronta'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      e = (await painel('GET', `/agente/execucoes/${t.corpo.id}`)).corpo;
    }
    expect(e).toMatchObject({ situacao: 'pronta', origem: 'teste', decisao: 'aprovar', simbolo: 'BTC/USDT' });
    expect(Object.keys(e.etapas as object).sort()).toEqual(['decisao', 'previsao']);
  });

  it('piloto automático cria a estratégia padrão uma vez só, em simulação', async () => {
    const { rodadaPiloto, PADRAO } = await import('../src/piloto/index.js');
    await rodadaPiloto();
    await rodadaPiloto();
    const padroes = await db.query<Record<string, unknown>>('select * from estrategias where nome = $1', [PADRAO.nome]);
    expect(padroes).toHaveLength(1);
    expect(padroes[0]).toMatchObject({
      simbolo: 'BTC/BRL', ativa: true, real: false, valor_ordem: 50, limite_diario: 50, limite_posicao: 50,
      ia_modo: 'obrigatorio', ia_tipo: 'agente', auto_ligado: true, auto_stop_pct: 3, auto_exigir_virada: false,
    });
    expect(padroes[0]).toMatchObject({ auto_varrer: true, auto_tempo: '15m', auto_intervalo_min: 2 });
    // a série falsa é uma alta reta (IFR 100): o piloto olhou os pares e não entrou
    expect(String(padroes[0]!.auto_situacao)).toContain('olhou 2 pares em velas de 15m: nenhum está para alta');
    expect(String(padroes[0]!.auto_situacao)).toContain('IFR esticado');
    expect(await saldo('BRL')).toBe(50);
  });

  it('piloto automático: stop de perda zera a posição sem passar pela IA', async () => {
    const { rodadaPiloto } = await import('../src/piloto/index.js');
    const [conta] = await db.query<{ id: number }>(`select id from contas where nome = 'Binance simulada'`);
    const est = await painel('POST', '/estrategias', {
      nome: 'Com piloto', conta_id: conta!.id, simbolo: 'BTC/USDT', ativa: true,
      valor_ordem: 50, limite_por_ordem: 50, limite_diario: 100, intervalo_min_seg: 0, auto_ligado: true, auto_stop_pct: 3,
    });
    expect(est.status).toBe(201);
    const t = String(est.corpo.webhook).split('/webhook/')[1]!;
    expect((await sinal({ acao: 'comprar', id: 'piloto-teste' }, t)).corpo).toMatchObject({ situacao: 'executado' });

    precoAgora = PRECO * 0.99; // -1%: segura
    await rodadaPiloto();
    let [pos] = await db.query<{ quantidade: number; maior_preco: number }>('select * from posicoes where estrategia_id = $1', [est.corpo.id]);
    expect(pos!.quantidade).toBeGreaterThan(0);
    expect(pos!.maior_preco).toBe(PRECO * 0.99);

    precoAgora = PRECO * 0.96; // -4%: passa do stop de 3%
    try {
      await rodadaPiloto();
    } finally {
      precoAgora = PRECO;
    }
    [pos] = await db.query<{ quantidade: number; maior_preco: number | null }>('select * from posicoes where estrategia_id = $1', [est.corpo.id]);
    expect(pos).toMatchObject({ quantidade: 0, maior_preco: null });
    const [ultimo] = await db.query<{ situacao: string; ip: string; corpo: { acao: string; id: string } }>(
      'select situacao, ip, corpo from sinais where estrategia_id = $1 order by id desc limit 1', [est.corpo.id]);
    expect(ultimo).toMatchObject({ situacao: 'executado', ip: 'piloto', corpo: { acao: 'zerar' } });
    expect(ultimo!.corpo.id).toMatch(/^piloto-stop-/);
    const [e] = await db.query<{ auto_situacao: string }>('select auto_situacao from estrategias where id = $1', [est.corpo.id]);
    expect(e!.auto_situacao).toContain('stop de perda');
  });

  it('piloto varre os pares da moeda, troca para o que virou para alta e compra', async () => {
    const { rodadaPiloto, PADRAO } = await import('../src/piloto/index.js');
    const { avaliarEntrada } = await import('../src/piloto/regras.js');
    await db.query('update estrategias set ativa = false where nome = $1', [PADRAO.nome]); // não disputa o saldo
    // a mesma série do teste das regras: alta longa, um tombo e a retomada; corta no dia da virada
    const s: number[] = [];
    for (let i = 0; i < 240; i++) s.push(100 + i * 0.3);
    for (let i = 0; i < 12; i++) s.push(s[s.length - 1]! * 0.985);
    for (let i = 0; i < 30; i++) s.push(s[s.length - 1]! * 1.006);
    const vela = (f: number, i: number) => ({ t: Date.UTC(2026, 9, 1) + i * 900_000, abre: f, max: f * 1.01, min: f * 0.99, fecha: f, volume: 1 });
    let n = 202;
    while (n <= s.length && !avaliarEntrada(s.slice(0, n).map(vela)).comprar) n++;
    expect(n).toBeLessThanOrEqual(s.length);
    velasEth = s.slice(0, n).map(vela);

    const [conta] = await db.query<{ id: number }>(`select id from contas where nome = 'Binance simulada'`);
    const est = await painel('POST', '/estrategias', {
      nome: 'Varredura', conta_id: conta!.id, simbolo: 'BTC/BRL', ativa: true, valor_ordem: 10, limite_por_ordem: 10, limite_diario: 10,
      intervalo_min_seg: 0, auto_ligado: true, auto_varrer: true, auto_tempo: '15m', auto_intervalo_min: 2,
    });
    expect(est.status).toBe(201);
    try {
      await rodadaPiloto();
    } finally {
      velasEth = null;
    }
    const [e] = await db.query<{ simbolo: string; auto_situacao: string }>('select simbolo, auto_situacao from estrategias where id = $1', [est.corpo.id]);
    expect(e!.simbolo).toBe('ETH/BRL');
    expect(e!.auto_situacao).toMatch(/^ETH\/BRL: virada para alta.*Kronos 72% de alta → executado/);
    const [ultimo] = await db.query<{ situacao: string; corpo: { simbolo: string; id: string } }>(
      'select situacao, corpo from sinais where estrategia_id = $1 order by id desc limit 1', [est.corpo.id]);
    expect(ultimo).toMatchObject({ situacao: 'executado', corpo: { simbolo: 'ETH/BRL' } });
    expect(ultimo!.corpo.id).toMatch(/^piloto-entrada-ETH\/BRL-/);

    // na passada seguinte, dentro dos 2 minutos, não varre de novo; com posição, só cuida do stop
    await rodadaPiloto();
    const sinais = await db.query('select 1 from sinais where estrategia_id = $1', [est.corpo.id]);
    expect(sinais).toHaveLength(1);
  });

  it('ponte MetaTrader 5: conta com token, cotações e velas da B3 e uma ordem pela fila', async () => {
    const c = await painel('POST', '/contas', { nome: 'XP', exchange: 'mt5', modo: 'real' });
    expect(c.status).toBe(201);
    expect(c.corpo).toMatchObject({ exchange: 'mt5', modo: 'real', tem_chave: true, ponte: { visto_em: null } });
    const tokenPonte = String(c.corpo.ponte_token);
    expect(tokenPonte.length).toBeGreaterThan(30);
    expect(c.corpo.estrategia_criada).toBeGreaterThan(0);
    expect(JSON.stringify((await painel('GET', '/contas')).corpo)).not.toContain(tokenPonte);

    const sincronizar = async (corpo: unknown, t = tokenPonte) => {
      const r = await fetch(`${base}/ponte/sincronizar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
        body: JSON.stringify(corpo),
      });
      return { status: r.status, corpo: (await r.json()) as { observar: string[]; tempos: string[]; comandos: { id: number; lado: string; simbolo: string; quantidade: number; idade_s: number }[] } };
    };
    expect((await sincronizar({}, 'x'.repeat(43))).status).toBe(401);

    const velasPetr = Array.from({ length: 60 }, (_, i) => [Date.UTC(2026, 7, 1) + i * 86_400_000, 37, 38, 36, 37 + i / 100, 1000]);
    const r1 = await sincronizar({
      versao: '1.0',
      conta: { corretora: 'XP Investimentos', servidor: 'XPMT5-PRD', moeda: 'BRL', saldo: 50, saldo_livre: 50, posicoes: {} },
      mercado: [{ simbolo: 'PETR4', cotacao: 38, volume_financeiro: 2e9, velas: { '1d': velasPetr } }],
    });
    expect(r1.status).toBe(200);
    expect(r1.corpo.observar).toEqual(expect.arrayContaining(['PETR4', 'VALE3', 'BOVA11']));
    expect(r1.corpo.tempos).toEqual(expect.arrayContaining(['15m', '1d']));
    expect(r1.corpo.comandos).toEqual([]);

    const mercado = await import('../src/brokers/mercado.js');
    expect(await mercado.cotacaoPublica('mt5', 'PETR4/BRL')).toBe(38);
    expect((await mercado.velas('mt5', 'PETR4/BRL', '1d')).at(-1)).toMatchObject({ fecha: 37.59 });
    const teste = await painel('POST', `/contas/${c.corpo.id}/testar`);
    expect(teste.corpo).toMatchObject({ publico: 'ok', privado: 'ok', saldos: { BRL: 50 } });

    // a ordem fica na fila até a ponte pegar; R$ 100 a R$ 38 = 2 ações (B3 só negocia ação inteira)
    const { CorretoraMt5 } = await import('../src/brokers/mt5.js');
    const ordem = new CorretoraMt5(Number(c.corpo.id)).comprar('PETR4/BRL', 100, 38);
    let cmd: { id: number; lado: string; simbolo: string; quantidade: number; idade_s: number } | undefined;
    for (let i = 0; i < 20 && !cmd; i++) {
      await new Promise((r) => setTimeout(r, 100));
      cmd = (await sincronizar({})).corpo.comandos[0];
    }
    expect(cmd).toMatchObject({ lado: 'compra', simbolo: 'PETR4', quantidade: 2 });
    expect(cmd!.idade_s).toBeLessThan(5);
    await sincronizar({ resultados: [{ id: cmd!.id, ok: true, preco: 38.1, quantidade: 2, id_exchange: '991' }] });
    expect(await ordem).toMatchObject({ quantidade: 2, precoMedio: 38.1, idExchange: '991' });

    // ordem recusada pela ponte vira erro; ordem velha não é entregue (expira)
    const recusada = new CorretoraMt5(Number(c.corpo.id)).vender('PETR4/BRL', 2, 38).catch((e: Error) => e.message);
    for (let i = 0; i < 20 && !(cmd = (await sincronizar({})).corpo.comandos[0]); i++) await new Promise((r) => setTimeout(r, 100));
    await sincronizar({ resultados: [{ id: cmd!.id, ok: false, erro: 'mercado fechado' }] });
    expect(await recusada).toBe('MT5: mercado fechado');
    await db.query(`insert into mt5_comandos (conta_id, dados, criado_em) values ($1, '{}', now() - interval '1 minute')`, [c.corpo.id]);
    expect((await sincronizar({})).corpo.comandos).toEqual([]);
    const [velha] = await db.query<{ situacao: string }>('select situacao from mt5_comandos order by id desc limit 1');
    expect(velha!.situacao).toBe('expirado');
  });

  it('assistente B3: conta sem chave, cotação do Yahoo, Telegram pareado e avisos confirmados pelo dono', async () => {
    const c = await painel('POST', '/contas', { nome: 'XP', exchange: 'b3', modo: 'real' });
    expect(c.status).toBe(201);
    expect(c.corpo).toMatchObject({ exchange: 'b3', modo: 'real', testnet: false });
    const estId = Number(c.corpo.estrategia_criada);
    const [est] = await db.query<Record<string, unknown>>('select * from estrategias where id = $1', [estId]);
    expect(est).toMatchObject({ simbolo: 'PETR4/BRL', real: false, auto_ligado: true, auto_varrer: true, auto_tempo: '1d', auto_intervalo_min: 10 });

    const mercado = await import('../src/brokers/mercado.js');
    expect(await mercado.cotacaoPublica('b3', 'PETR4/BRL')).toBe(38.2);
    const velas = await mercado.velas('b3', 'PETR4/BRL', '1d');
    expect(velas).toHaveLength(249); // a vela sem fechamento (null) fica de fora
    await expect(mercado.cotacaoPublica('b3', 'XPTO3/BRL')).rejects.toThrow('não existe');

    // Telegram: token conferido no getMe, código de pareamento, e só o chat com o código vira o dono
    expect((await painel('PUT', '/telegram', { token: 'curto' })).status).toBe(400);
    const tg = await painel('PUT', '/telegram', { token: '123456789:AAHfakeTokenParaTeste_abcdefghij' });
    expect(tg.corpo).toMatchObject({ configurado: true, bot: 'meu_bot_teste', pareado: false });
    expect(JSON.stringify((await painel('GET', '/telegram')).corpo)).not.toContain('AAHfake');
    const { tratarAtualizacao } = await import('../src/assistente/index.js');
    await tratarAtualizacao({ update_id: 1, message: { message_id: 1, chat: { id: 999 }, text: '/start ERRADO' } });
    expect((await painel('GET', '/telegram')).corpo).toMatchObject({ pareado: false });
    await tratarAtualizacao({ update_id: 2, message: { message_id: 2, chat: { id: 4242 }, text: `/start ${tg.corpo.codigo}` } });
    expect((await painel('GET', '/telegram')).corpo).toMatchObject({ pareado: true });
    expect(mensagensTelegram.at(-1)).toMatchObject({ metodo: 'sendMessage', corpo: { chat_id: 4242 } });

    // aviso de compra (o motor cria com as três chaves; aqui direto): vai para o Telegram com botões
    const { notificarAlerta } = await import('../src/assistente/index.js');
    const [a1] = await db.query<{ id: number }>(
      `insert into alertas (estrategia_id, lado, simbolo, quantidade, preco_ref, stop, alvo, motivo, expira_em)
       values ($1, 'compra', 'PETR4/BRL', 1, 38.2, 37.05, 40.49, 'virada para alta', now() + interval '30 minutes') returning id`, [estId]);
    await notificarAlerta(a1!.id);
    const aviso = mensagensTelegram.at(-1)!;
    expect(String(aviso.corpo.text)).toContain('COMPRAR 1 ação de PETR4');
    expect(String(aviso.corpo.text)).toContain('STOP de venda em R$ 37,05');
    expect(JSON.stringify(aviso.corpo.reply_markup)).toContain(`c:${a1!.id}`);

    // alguém que não é o dono aperta o botão: nada acontece
    await tratarAtualizacao({ update_id: 3, callback_query: { id: 'x', data: `c:${a1!.id}`, message: { message_id: 9, chat: { id: 999 } } } });
    expect((await db.query<{ situacao: string }>('select situacao from alertas where id = $1', [a1!.id]))[0]!.situacao).toBe('pendente');

    // o dono comprou a outro preço: responde "38,10 1" à pergunta do bot
    await tratarAtualizacao({ update_id: 4, callback_query: { id: 'y', data: `p:${a1!.id}`, message: { message_id: 9, chat: { id: 4242 } } } });
    const [{ pergunta_msg_id: pergunta }] = await db.query<{ pergunta_msg_id: number }>('select pergunta_msg_id from alertas where id = $1', [a1!.id]) as [{ pergunta_msg_id: number }];
    await tratarAtualizacao({ update_id: 5, message: { message_id: 10, chat: { id: 4242 }, text: '38,10 1', reply_to_message: { message_id: pergunta } } });
    const [ordem] = await db.query<Record<string, unknown>>('select * from ordens where estrategia_id = $1', [estId]);
    expect(ordem).toMatchObject({ lado: 'compra', modo: 'real', manual: true, quantidade: 1, preco_medio: 38.1, situacao: 'executada' });
    const [pos] = await db.query<Record<string, unknown>>('select * from posicoes where estrategia_id = $1', [estId]);
    expect(pos).toMatchObject({ quantidade: 1, custo_total: 38.1, stop_avisado: 37.05 });
    // confirmar de novo não duplica
    expect((await painel('POST', `/alertas/${a1!.id}/confirmar`, {})).status).toBe(400);

    // aviso de venda pelo painel: "ainda tenho" e depois "vendi"
    const [a2] = await db.query<{ id: number }>(`insert into alertas (estrategia_id, lado, simbolo, quantidade, preco_ref) values ($1, 'venda', 'PETR4/BRL', 1, 37) returning id`, [estId]);
    const { avisoEmAberto } = await import('../src/assistente/index.js');
    expect(await avisoEmAberto(estId)).toBe(true);
    expect((await painel('POST', `/alertas/${a2!.id}/recusar`, {})).corpo).toMatchObject({ ok: true });
    expect(await avisoEmAberto(estId)).toBe(true); // recusou a venda há pouco: não repete por 30 min
    const [a3] = await db.query<{ id: number }>(`insert into alertas (estrategia_id, lado, simbolo, quantidade, preco_ref) values ($1, 'venda', 'PETR4/BRL', 5, 37) returning id`, [estId]);
    const vendi = await painel('POST', `/alertas/${a3!.id}/confirmar`, { preco: 36.9 });
    expect(vendi.corpo).toMatchObject({ ok: true });
    const [posDepois] = await db.query<Record<string, unknown>>('select * from posicoes where estrategia_id = $1', [estId]);
    expect(posDepois).toMatchObject({ quantidade: 0, stop_avisado: null });
    const vendas = await db.query<{ quantidade: number }>(`select quantidade from ordens where estrategia_id = $1 and lado = 'venda'`, [estId]);
    expect(vendas).toEqual([{ quantidade: 1 }]); // vende só o que tinha

    // compra sem resposta expira
    const [a4] = await db.query<{ id: number }>(
      `insert into alertas (estrategia_id, lado, simbolo, quantidade, preco_ref, expira_em) values ($1, 'compra', 'PETR4/BRL', 1, 38, now() - interval '1 minute') returning id`, [estId]);
    const { expirarAlertas } = await import('../src/assistente/index.js');
    await expirarAlertas();
    expect((await db.query<{ situacao: string }>('select situacao from alertas where id = $1', [a4!.id]))[0]!.situacao).toBe('expirado');
    const lista = await painel('GET', '/alertas');
    expect((lista.corpo as unknown as { situacao: string }[]).map((x) => x.situacao)).toEqual(expect.arrayContaining(['confirmado', 'recusado', 'expirado']));
  });

  it('uma estratégia por moeda e ordem manual do dono (sem esperar a IA)', async () => {
    const conta = await painel('POST', '/contas', { nome: 'Binance 2', exchange: 'binance', saldo_inicial: { moeda: 'BRL', quantidade: 100 } });
    const r = await painel('POST', '/estrategias/todas-as-moedas', { conta_id: conta.corpo.id });
    expect(r.status).toBe(201);
    expect(r.corpo).toMatchObject({ criadas: ['BTC/BRL', 'ETH/BRL'] });
    expect((await painel('POST', '/estrategias/todas-as-moedas', { conta_id: conta.corpo.id })).corpo).toMatchObject({ criadas: [] });
    const [btc] = await db.query<Record<string, unknown>>('select * from estrategias where conta_id = $1 and simbolo = $2', [conta.corpo.id, 'BTC/BRL']);
    expect(btc).toMatchObject({ nome: 'Piloto BTC', real: false, valor_ordem: 15, ia_modo: 'obrigatorio', auto_varrer: false, auto_tempo: '1m', auto_max_ia_dia: 2, auto_stop_pct: 1.5 });

    // IA obrigatória, mas a ordem é do dono: sai sem consultar a IA, dentro dos limites
    const pedidos = pedidosIa.length;
    const compra = await painel('POST', `/estrategias/${btc!.id}/ordem`, { acao: 'comprar', valor: 15 });
    expect(compra.corpo).toMatchObject({ situacao: 'executado' });
    expect(pedidosIa.length).toBe(pedidos);
    expect((await painel('POST', `/estrategias/${btc!.id}/ordem`, { acao: 'comprar', valor: 500 })).corpo).toMatchObject({ situacao: 'rejeitado' });
    const venda = await painel('POST', `/estrategias/${btc!.id}/ordem`, { acao: 'zerar' });
    expect(venda.corpo).toMatchObject({ situacao: 'executado' });
    const [s] = await db.query<{ ip: string }>('select ip from sinais where estrategia_id = $1 order by id desc limit 1', [btc!.id]);
    expect(s!.ip).toBe('painel');
    expect((await painel('POST', '/estrategias/999999/ordem', { acao: 'zerar' })).status).toBe(404);
  });

  it('auditoria registrou as ações do painel', async () => {
    const tipos = (await db.query<{ tipo: string }>('select tipo from eventos')).map((e) => e.tipo);
    expect(tipos).toEqual(expect.arrayContaining(['login', 'conta_criada', 'estrategia_criada', 'parada_ligada', 'parada_desligada']));
  });

  it('saúde', async () => {
    const r = await fetch(base + '/saude');
    expect(await r.json()).toMatchObject({ ok: true, banco: 'ok' });
  });
});
