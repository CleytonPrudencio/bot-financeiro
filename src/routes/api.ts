import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { apagarSessao, entrar, exigeCabecalhoPainel, exigeLogin, gravarSessao } from '../auth.js';
import { config } from '../config.js';
import { cifrar, derivarChave, novoToken } from '../crypto.js';
import { query, transacao, umOuNada } from '../db.js';
import { corretoraReal, type Conta, type Estrategia } from '../motor.js';
import { cotacaoPublica, exchangePublica, exchangesSuportadas } from '../brokers/ccxt.js';
import { moedas } from '../brokers/tipos.js';

const chave = derivarChave(config.chaveCifra);

export const api = Router();
api.use(exigeCabecalhoPainel);

// ------------------------------------------------------------------ sessão

const limiteLogin = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

api.post('/login', limiteLogin, async (req, res) => {
  const dados = z.object({ email: z.string().email(), senha: z.string().min(1).max(200) }).safeParse(req.body);
  if (!dados.success) return void res.status(400).json({ erro: 'e-mail e senha' });
  const u = await entrar(dados.data.email, dados.data.senha);
  if (!u) return void res.status(401).json({ erro: 'e-mail ou senha errados' });
  gravarSessao(res, u.id);
  await evento(u.id, 'login', {});
  res.json({ email: u.email });
});

api.post('/logout', (_req, res) => {
  apagarSessao(res);
  res.json({ ok: true });
});

// daqui para baixo, só com login
api.use(exigeLogin);

api.get('/sessao', async (req, res) => {
  const u = await umOuNada<{ email: string }>('select email from usuarios where id = $1', [req.usuarioId]);
  if (!u) return void res.status(401).json({ erro: 'faça login' });
  res.json({ email: u.email });
});

// ------------------------------------------------------------------ utilidades

async function evento(usuarioId: number | undefined, tipo: string, detalhe: object): Promise<void> {
  await query('insert into eventos (usuario_id, tipo, detalhe) values ($1, $2, $3)', [usuarioId ?? null, tipo, JSON.stringify(detalhe)]);
}

function id(req: Request): number {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new ErroPedido('id inválido');
  return n;
}

class ErroPedido extends Error {}

function validar<T>(esquema: z.ZodType<T>, corpo: unknown): T {
  const r = esquema.safeParse(corpo);
  if (!r.success) {
    const p = r.error.issues[0];
    throw new ErroPedido(`${p?.path.join('.') || 'corpo'}: ${p?.message ?? 'inválido'}`);
  }
  return r.data;
}

/** Conta como o painel vê: nunca devolve as chaves, só se existem. */
function contaPublica(c: Conta) {
  return {
    id: c.id,
    nome: c.nome,
    exchange: c.exchange,
    modo: c.modo,
    testnet: c.testnet,
    tem_chave: Boolean(c.api_key_cifrada && c.api_secret_cifrada),
    taxa_simulada_pct: c.taxa_simulada_pct,
  };
}

function urlWebhook(token: string): string {
  return `${config.urlPublica.replace(/\/$/, '')}/webhook/${token}`;
}

// ------------------------------------------------------------------ resumo e parada geral

api.get('/resumo', async (_req, res) => {
  const [parada] = await query<{ valor: boolean }>(`select valor from configuracoes where chave = 'parada_geral'`);
  const [hoje] = await query<{ ordens: number; compras: number; vendas: number; erros: number }>(
    `select count(*) filter (where situacao = 'executada') as ordens,
            coalesce(sum(custo) filter (where situacao = 'executada' and lado = 'compra'), 0) as compras,
            coalesce(sum(custo - taxa) filter (where situacao = 'executada' and lado = 'venda'), 0) as vendas,
            count(*) filter (where situacao = 'erro') as erros
       from ordens where criada_em >= (date_trunc('day', now() at time zone $1) at time zone $1)`,
    [config.fuso],
  );
  const estrategias = await query(
    `select e.id, e.nome, e.simbolo, e.ativa, e.real, c.nome as conta, c.modo as conta_modo,
            coalesce(p.quantidade, 0) as posicao, coalesce(p.custo_total, 0) as custo_posicao
       from estrategias e join contas c on c.id = e.conta_id
       left join posicoes p on p.estrategia_id = e.id
      order by e.ativa desc, e.nome`,
  );
  res.json({
    parada_geral: parada?.valor === true,
    real_no_servidor: config.realLiberadoNoServidor,
    hoje,
    estrategias,
  });
});

api.post('/parada', async (req, res) => {
  const { ligada } = validar(z.object({ ligada: z.boolean() }), req.body);
  await query(`update configuracoes set valor = $1, alterado_em = now() where chave = 'parada_geral'`, [JSON.stringify(ligada)]);
  await evento(req.usuarioId, ligada ? 'parada_ligada' : 'parada_desligada', {});
  res.json({ parada_geral: ligada });
});

// ------------------------------------------------------------------ contas

api.get('/exchanges', (_req, res) => {
  res.json(exchangesSuportadas());
});

const textoChave = z.string().trim().min(1).max(500);

const esquemaConta = z.object({
  nome: z.string().trim().min(1).max(80),
  exchange: z.string().trim().min(1).max(40),
  modo: z.enum(['simulacao', 'real']).default('simulacao'),
  testnet: z.boolean().default(false),
  api_key: textoChave.optional(),
  api_secret: textoChave.optional(),
  api_senha: textoChave.optional(),
  taxa_simulada_pct: z.number().min(0).max(5).default(0.1),
  saldo_inicial: z.object({ moeda: z.string().trim().toUpperCase().min(1).max(15), quantidade: z.number().min(0) }).optional(),
});

api.get('/contas', async (_req, res) => {
  const contas = await query<Conta>('select * from contas order by nome');
  res.json(contas.map(contaPublica));
});

api.post('/contas', async (req, res) => {
  const d = validar(esquemaConta, req.body);
  if (!exchangesSuportadas().includes(d.exchange)) throw new ErroPedido(`exchange "${d.exchange}" não suportada`);
  if (d.modo === 'real' && !(d.api_key && d.api_secret)) throw new ErroPedido('conta real precisa de chave e segredo da API');
  const conta = await transacao(async (c) => {
    const r = await c.query<Conta>(
      `insert into contas (nome, exchange, modo, testnet, api_key_cifrada, api_secret_cifrada, api_senha_cifrada, taxa_simulada_pct)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        d.nome, d.exchange, d.modo, d.testnet,
        d.api_key ? cifrar(d.api_key, chave) : null,
        d.api_secret ? cifrar(d.api_secret, chave) : null,
        d.api_senha ? cifrar(d.api_senha, chave) : null,
        d.taxa_simulada_pct,
      ],
    );
    const nova = r.rows[0]!;
    if (d.saldo_inicial) {
      await c.query('insert into saldos_simulados (conta_id, moeda, quantidade) values ($1, $2, $3)', [
        nova.id, d.saldo_inicial.moeda, d.saldo_inicial.quantidade,
      ]);
    }
    return nova;
  });
  await evento(req.usuarioId, 'conta_criada', { conta: conta.id, exchange: conta.exchange, modo: conta.modo });
  res.status(201).json(contaPublica(conta));
});

api.patch('/contas/:id', async (req, res) => {
  const contaId = id(req);
  const d = validar(
    esquemaConta.omit({ saldo_inicial: true, exchange: true }).partial().extend({ apagar_chaves: z.boolean().optional() }),
    req.body,
  );
  const atual = await umOuNada<Conta>('select * from contas where id = $1', [contaId]);
  if (!atual) return void res.status(404).json({ erro: 'conta não existe' });

  const novaKey = d.apagar_chaves ? null : d.api_key ? cifrar(d.api_key, chave) : atual.api_key_cifrada;
  const novoSecret = d.apagar_chaves ? null : d.api_secret ? cifrar(d.api_secret, chave) : atual.api_secret_cifrada;
  const novaSenha = d.apagar_chaves ? null : d.api_senha ? cifrar(d.api_senha, chave) : atual.api_senha_cifrada;
  const modo = d.modo ?? atual.modo;
  if (modo === 'real' && !(novaKey && novoSecret)) throw new ErroPedido('conta real precisa de chave e segredo da API');
  if (modo === 'simulacao') {
    // conta voltou para simulação: nenhuma estratégia dela pode continuar marcada como real
    await query('update estrategias set real = false where conta_id = $1 and real', [contaId]);
  }

  const r = await query<Conta>(
    `update contas set nome = $2, modo = $3, testnet = $4, api_key_cifrada = $5, api_secret_cifrada = $6,
            api_senha_cifrada = $7, taxa_simulada_pct = $8 where id = $1 returning *`,
    [contaId, d.nome ?? atual.nome, modo, d.testnet ?? atual.testnet, novaKey, novoSecret, novaSenha, d.taxa_simulada_pct ?? atual.taxa_simulada_pct],
  );
  await evento(req.usuarioId, 'conta_alterada', {
    conta: contaId,
    campos: Object.keys(d).filter((k) => !k.startsWith('api_')),
    chaves_trocadas: Boolean(d.api_key || d.api_secret || d.api_senha || d.apagar_chaves),
    modo_antes: atual.modo,
    modo_depois: modo,
  });
  res.json(contaPublica(r[0]!));
});

/** Confere se a exchange responde: cotação pública e, se houver chave, o saldo. */
api.post('/contas/:id/testar', async (req, res) => {
  const conta = await umOuNada<Conta>('select * from contas where id = $1', [id(req)]);
  if (!conta) return void res.status(404).json({ erro: 'conta não existe' });
  const resultado: { publico: string; privado?: string; saldos?: Record<string, number> } = { publico: 'ok' };
  try {
    await exchangePublica(conta.exchange);
  } catch (e) {
    resultado.publico = (e as Error).message;
  }
  if (conta.api_key_cifrada) {
    try {
      resultado.saldos = await corretoraReal(conta).saldos();
      resultado.privado = 'ok';
    } catch (e) {
      resultado.privado = (e as Error).message;
    }
  }
  res.json(resultado);
});

api.get('/contas/:id/saldos', async (req, res) => {
  const contaId = id(req);
  const simulados = await query('select moeda, quantidade from saldos_simulados where conta_id = $1 order by moeda', [contaId]);
  res.json({ simulados });
});

/** Define o saldo simulado de uma moeda (para começar ou recomeçar uma simulação). */
api.put('/contas/:id/saldos/:moeda', async (req, res) => {
  const contaId = id(req);
  const moeda = String(req.params.moeda).toUpperCase();
  const { quantidade } = validar(z.object({ quantidade: z.number().min(0) }), req.body);
  await query(
    `insert into saldos_simulados (conta_id, moeda, quantidade) values ($1, $2, $3)
     on conflict (conta_id, moeda) do update set quantidade = $3`,
    [contaId, moeda, quantidade],
  );
  await evento(req.usuarioId, 'saldo_simulado', { conta: contaId, moeda, quantidade });
  res.json({ moeda, quantidade });
});

// ------------------------------------------------------------------ estratégias

const valor = z.number().positive();

const esquemaEstrategia = z
  .object({
    nome: z.string().trim().min(1).max(80),
    conta_id: z.number().int().positive(),
    simbolo: z.string().trim().toUpperCase().regex(/^[A-Z0-9.\-_]+\/[A-Z0-9.\-_]+(:[A-Z0-9]+)?$/, 'use BASE/COTACAO, ex. BTC/USDT'),
    ativa: z.boolean().default(false),
    real: z.boolean().default(false),
    valor_ordem: valor,
    limite_por_ordem: valor,
    limite_diario: valor,
    limite_posicao: valor.nullable().default(null),
    intervalo_min_seg: z.number().int().min(0).max(86_400).default(60),
    desvio_max_pct: z.number().min(0.01).max(50).default(1),
    ips_permitidos: z.string().trim().max(1000).nullable().default(null),
  });

function conferirLimites(e: { valor_ordem: number; limite_por_ordem: number; limite_diario: number }): void {
  if (e.valor_ordem > e.limite_por_ordem) throw new ErroPedido('o valor da ordem não pode passar do limite por ordem');
  if (e.limite_por_ordem > e.limite_diario) throw new ErroPedido('o limite por ordem não pode passar do limite diário');
}

async function conferirSimbolo(exchange: string, simbolo: string): Promise<void> {
  moedas(simbolo);
  let ex;
  try {
    ex = await exchangePublica(exchange);
  } catch {
    return; // sem acesso à exchange agora: a conferência fica para o primeiro sinal
  }
  if (!ex.markets?.[simbolo]) throw new ErroPedido(`o par ${simbolo} não existe na ${exchange}`);
}

api.get('/estrategias', async (_req, res) => {
  res.json(
    await query(
      `select e.*, c.nome as conta, c.modo as conta_modo, c.exchange,
              coalesce(p.quantidade, 0) as posicao, coalesce(p.custo_total, 0) as custo_posicao
         from estrategias e join contas c on c.id = e.conta_id
         left join posicoes p on p.estrategia_id = e.id
        order by e.nome`,
    ).then((linhas) => linhas.map(({ token_hash: _omitido, ...resto }) => resto)),
  );
});

api.post('/estrategias', async (req, res) => {
  const d = validar(esquemaEstrategia, req.body);
  conferirLimites(d);
  const conta = await umOuNada<Conta>('select * from contas where id = $1', [d.conta_id]);
  if (!conta) throw new ErroPedido('conta não existe');
  if (d.real && conta.modo !== 'real') throw new ErroPedido('só dá para marcar como real uma estratégia de conta real');
  await conferirSimbolo(conta.exchange, d.simbolo);
  const t = novoToken();
  const r = await query<Estrategia>(
    `insert into estrategias (nome, conta_id, simbolo, ativa, real, token_hash, token_prefixo, valor_ordem, limite_por_ordem,
                              limite_diario, limite_posicao, intervalo_min_seg, desvio_max_pct, ips_permitidos)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
    [d.nome, d.conta_id, d.simbolo, d.ativa, d.real, t.hash, t.prefixo, d.valor_ordem, d.limite_por_ordem,
      d.limite_diario, d.limite_posicao, d.intervalo_min_seg, d.desvio_max_pct, d.ips_permitidos || null],
  );
  await evento(req.usuarioId, 'estrategia_criada', { estrategia: r[0]!.id, real: d.real });
  // o token só aparece agora; no banco fica só o hash
  res.status(201).json({ id: r[0]!.id, webhook: urlWebhook(t.token) });
});

api.patch('/estrategias/:id', async (req, res) => {
  const estId = id(req);
  const atual = await umOuNada<Estrategia>('select * from estrategias where id = $1', [estId]);
  if (!atual) return void res.status(404).json({ erro: 'estratégia não existe' });
  const d = validar(esquemaEstrategia.omit({ conta_id: true }).partial(), req.body);
  const novo = { ...atual, ...d };
  conferirLimites(novo);
  const conta = (await umOuNada<Conta>('select * from contas where id = $1', [atual.conta_id]))!;
  if (novo.real && conta.modo !== 'real') throw new ErroPedido('só dá para marcar como real uma estratégia de conta real');
  if (d.simbolo && d.simbolo !== atual.simbolo) {
    const [pos] = await query<{ quantidade: number }>('select quantidade from posicoes where estrategia_id = $1', [estId]);
    if ((pos?.quantidade ?? 0) > 0) throw new ErroPedido('zere a posição antes de trocar o par');
    await conferirSimbolo(conta.exchange, d.simbolo);
  }
  await query(
    `update estrategias set nome = $2, simbolo = $3, ativa = $4, real = $5, valor_ordem = $6, limite_por_ordem = $7,
            limite_diario = $8, limite_posicao = $9, intervalo_min_seg = $10, desvio_max_pct = $11, ips_permitidos = $12
      where id = $1`,
    [estId, novo.nome, novo.simbolo, novo.ativa, novo.real, novo.valor_ordem, novo.limite_por_ordem, novo.limite_diario,
      novo.limite_posicao, novo.intervalo_min_seg, novo.desvio_max_pct, novo.ips_permitidos || null],
  );
  await evento(req.usuarioId, 'estrategia_alterada', { estrategia: estId, mudou: d });
  res.json({ ok: true });
});

/** Gera um token novo; o antigo para de valer na hora. */
api.post('/estrategias/:id/novo-token', async (req, res) => {
  const estId = id(req);
  const t = novoToken();
  const r = await query('update estrategias set token_hash = $2, token_prefixo = $3 where id = $1 returning id', [estId, t.hash, t.prefixo]);
  if (!r.length) return void res.status(404).json({ erro: 'estratégia não existe' });
  await evento(req.usuarioId, 'token_trocado', { estrategia: estId });
  res.json({ webhook: urlWebhook(t.token) });
});

/** Cotação atual do par da estratégia, para conferir no painel. */
api.get('/estrategias/:id/cotacao', async (req, res) => {
  const e = await umOuNada<{ simbolo: string; exchange: string }>(
    'select e.simbolo, c.exchange from estrategias e join contas c on c.id = e.conta_id where e.id = $1',
    [id(req)],
  );
  if (!e) return void res.status(404).json({ erro: 'estratégia não existe' });
  res.json({ simbolo: e.simbolo, cotacao: await cotacaoPublica(e.exchange, e.simbolo) });
});

// ------------------------------------------------------------------ histórico

const filtro = z.object({
  estrategia: z.coerce.number().int().positive().optional(),
  limite: z.coerce.number().int().min(1).max(500).default(100),
});

api.get('/sinais', async (req, res) => {
  const f = validar(filtro, req.query);
  res.json(
    await query(
      `select s.id, s.estrategia_id, e.nome as estrategia, s.acao, s.situacao, s.motivo, s.ip, s.corpo, s.recebido_em
         from sinais s left join estrategias e on e.id = s.estrategia_id
        where ($1::bigint is null or s.estrategia_id = $1)
        order by s.recebido_em desc limit $2`,
      [f.estrategia ?? null, f.limite],
    ),
  );
});

api.get('/ordens', async (req, res) => {
  const f = validar(filtro, req.query);
  res.json(
    await query(
      `select o.*, e.nome as estrategia from ordens o join estrategias e on e.id = o.estrategia_id
        where ($1::bigint is null or o.estrategia_id = $1)
        order by o.criada_em desc limit $2`,
      [f.estrategia ?? null, f.limite],
    ),
  );
});

api.get('/eventos', async (_req, res) => {
  res.json(
    await query(
      `select ev.id, u.email, ev.tipo, ev.detalhe, ev.criado_em from eventos ev
         left join usuarios u on u.id = ev.usuario_id order by ev.criado_em desc limit 200`,
    ),
  );
});

// ------------------------------------------------------------------ erros

api.use((err: unknown, _req: Request, res: Response, _next: (e?: unknown) => void) => {
  if (err instanceof ErroPedido) return void res.status(400).json({ erro: err.message });
  throw err;
});
