// Teste de ponta a ponta com Postgres de verdade: painel → conta simulada → estratégia →
// webhook → ordem → saldo e posição. A cotação da exchange é fixa (sem internet).
//
// Roda só com TEST_DATABASE_URL apontando para um banco VAZIO, que o teste apaga e recria:
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/bot_teste npm test

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_BANCO = process.env.TEST_DATABASE_URL;
const PRECO = 50_000;

vi.mock('../src/brokers/ccxt.js', () => ({
  exchangesSuportadas: () => ['binance'],
  exchangePublica: async () => ({ markets: { 'BTC/USDT': {} } }),
  cotacaoPublica: async () => PRECO,
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
    const { criarApp } = await import('../src/app.js');
    servidor = criarApp().listen(0);
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    servidor?.close();
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

  it('auditoria registrou as ações do painel', async () => {
    const tipos = (await db.query<{ tipo: string }>('select tipo from eventos')).map((e) => e.tipo);
    expect(tipos).toEqual(expect.arrayContaining(['login', 'conta_criada', 'estrategia_criada', 'parada_ligada', 'parada_desligada']));
  });

  it('saúde', async () => {
    const r = await fetch(base + '/saude');
    expect(await r.json()).toMatchObject({ ok: true, banco: 'ok' });
  });
});
