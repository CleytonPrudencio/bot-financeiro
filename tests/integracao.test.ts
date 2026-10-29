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

vi.mock('../src/brokers/ccxt.js', () => ({
  exchangesSuportadas: () => ['binance'],
  exchangePublica: async () => ({ markets: { 'BTC/USDT': {} } }),
  cotacaoPublica: async () => precoAgora,
  velasDiarias: async () =>
    Array.from({ length: 300 }, (_, i) => {
      const f = PRECO * (0.8 + i / 1000);
      return { t: Date.UTC(2026, 0, 1) + i * 86_400_000, abre: f, max: f * 1.01, min: f * 0.99, fecha: f, volume: 1000 };
    }),
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
      ia_modo: 'obrigatorio', ia_tipo: 'agente', auto_ligado: true, auto_stop_pct: 3,
    });
    // a série falsa é uma alta reta (IFR 100): o piloto olhou a vela e não entrou
    expect(String(padroes[0]!.auto_situacao)).toContain('sem entrada');
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

  it('auditoria registrou as ações do painel', async () => {
    const tipos = (await db.query<{ tipo: string }>('select tipo from eventos')).map((e) => e.tipo);
    expect(tipos).toEqual(expect.arrayContaining(['login', 'conta_criada', 'estrategia_criada', 'parada_ligada', 'parada_desligada']));
  });

  it('saúde', async () => {
    const r = await fetch(base + '/saude');
    expect(await r.json()).toMatchObject({ ok: true, banco: 'ok' });
  });
});
