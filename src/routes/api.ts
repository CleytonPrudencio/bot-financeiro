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
import { iniciarAnalise } from '../analise/index.js';
import { agentePronto, iniciarTeste, lerConfig, salvarConfig, type ConfigAgente } from '../agente/index.js';
import { ETAPAS, montarAutomatico } from '../agente/etapas.js';
import { saudeKronos } from '../previsao/kronos.js';
import { AGENTES } from '../analise/agentes.js';
import {
  consultarIas, MODELOS_CLAUDE, pedirParecer, perguntarIas, PEDIDO_DE_TESTE, PRESETS_COMPATIVEIS,
  type ConectorIa, type PedidoParecer,
} from '../ia/index.js';

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

/**
 * Para PATCH: fica só com os campos que vieram no corpo. Sem isto, os `.default()` do esquema
 * preenchem o que não veio (editar o nome de uma estratégia a desativava; de uma conta real, a
 * voltava para simulação).
 */
function soEnviados<T extends object>(dados: T, corpo: unknown): Partial<T> {
  const enviados = corpo && typeof corpo === 'object' ? corpo : {};
  return Object.fromEntries(Object.entries(dados).filter(([k]) => Object.hasOwn(enviados, k))) as Partial<T>;
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
  // últimos 14 dias, um ponto por dia (fuso de São Paulo), para o gráfico do painel
  const serie = await query(
    `with dias as (
       select generate_series((now() at time zone $1)::date - 13, (now() at time zone $1)::date, '1 day')::date as dia
     )
     select to_char(d.dia, 'YYYY-MM-DD') as dia,
            coalesce(sum(o.custo) filter (where o.lado = 'compra'), 0) as compras,
            coalesce(sum(o.custo - o.taxa) filter (where o.lado = 'venda'), 0) as vendas,
            count(o.id) as ordens
       from dias d
       left join ordens o on o.situacao = 'executada' and (o.criada_em at time zone $1)::date = d.dia
      group by d.dia order by d.dia`,
    [config.fuso],
  );
  const sinais7d = await query<{ situacao: string; total: number }>(
    `select situacao, count(*) as total from sinais where recebido_em >= now() - interval '7 days' group by situacao`,
  );
  const ultimas = await query(
    `select o.id, o.criada_em, o.lado, o.simbolo, o.custo, o.modo, o.situacao, e.nome as estrategia
       from ordens o join estrategias e on e.id = o.estrategia_id order by o.criada_em desc limit 8`,
  );
  const [ias] = await query<{ ativas: number; total: number }>(
    'select count(*) filter (where ativo) as ativas, count(*) as total from conectores_ia',
  );
  res.json({
    parada_geral: parada?.valor === true,
    real_no_servidor: config.realLiberadoNoServidor,
    hoje,
    estrategias,
    serie,
    sinais7d,
    ultimas,
    ias,
  });
});

// Cotação dos pares das estratégias, para a faixa de cotações do painel. Guarda 20 s.
let cacheCotacoes: { em: number; dados: unknown } | null = null;
api.get('/cotacoes', async (_req, res) => {
  if (cacheCotacoes && Date.now() - cacheCotacoes.em < 20_000) return void res.json(cacheCotacoes.dados);
  const pares = await query<{ exchange: string; simbolo: string }>(
    `select distinct c.exchange, e.simbolo from estrategias e join contas c on c.id = e.conta_id order by 1, 2 limit 12`,
  );
  const dados = await Promise.all(
    pares.map(async (p) => {
      try {
        return { ...p, cotacao: await cotacaoPublica(p.exchange, p.simbolo) };
      } catch {
        return { ...p, cotacao: null };
      }
    }),
  );
  cacheCotacoes = { em: Date.now(), dados };
  res.json(dados);
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
  const d = soEnviados(
    validar(esquemaConta.omit({ saldo_inicial: true, exchange: true }).partial().extend({ apagar_chaves: z.boolean().optional() }), req.body),
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
    ia_modo: z.enum(['desligado', 'consultivo', 'obrigatorio']).default('desligado'),
    ia_tipo: z.enum(['conselho', 'agente']).default('conselho'),
    ia_conectores: z.array(z.number().int().positive()).max(20).default([]),
    ia_quorum: z.number().int().min(1).max(20).nullable().default(null),
    ia_falha: z.enum(['reprova', 'ignora']).default('reprova'),
    ia_confianca_min: z.number().min(0).max(1).default(0.6),
    ia_nas_vendas: z.boolean().default(false),
    ia_contexto: z.string().trim().max(2000).nullable().default(null),
    analise_nota_min: z.number().int().min(0).max(100).nullable().default(null),
    analise_validade_h: z.number().int().min(1).max(720).default(24),
    auto_ligado: z.boolean().default(false),
    auto_stop_pct: z.number().min(0.1).max(50).default(3),
    auto_alvo_pct: z.number().min(0.1).max(200).default(6),
    auto_protecao_pct: z.number().min(0.1).max(100).default(2.5),
    auto_recuo_pct: z.number().min(0.1).max(50).default(1.5),
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
              coalesce(p.quantidade, 0) as posicao, coalesce(p.custo_total, 0) as custo_posicao,
              (select coalesce(sum(o.custo), 0) from ordens o
                where o.estrategia_id = e.id and o.situacao = 'executada' and o.lado = 'compra'
                  and o.criada_em >= (date_trunc('day', now() at time zone $1) at time zone $1)) as gasto_hoje
         from estrategias e join contas c on c.id = e.conta_id
         left join posicoes p on p.estrategia_id = e.id
        order by e.nome`,
      [config.fuso],
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
                              limite_diario, limite_posicao, intervalo_min_seg, desvio_max_pct, ips_permitidos,
                              ia_modo, ia_conectores, ia_quorum, ia_falha, ia_confianca_min, ia_nas_vendas, ia_contexto,
                              analise_nota_min, analise_validade_h, ia_tipo,
                              auto_ligado, auto_stop_pct, auto_alvo_pct, auto_protecao_pct, auto_recuo_pct)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
             $25, $26, $27, $28, $29) returning id`,
    [d.nome, d.conta_id, d.simbolo, d.ativa, d.real, t.hash, t.prefixo, d.valor_ordem, d.limite_por_ordem,
      d.limite_diario, d.limite_posicao, d.intervalo_min_seg, d.desvio_max_pct, d.ips_permitidos || null,
      d.ia_modo, d.ia_conectores, d.ia_quorum, d.ia_falha, d.ia_confianca_min, d.ia_nas_vendas, d.ia_contexto || null,
      d.analise_nota_min, d.analise_validade_h, d.ia_tipo,
      d.auto_ligado, d.auto_stop_pct, d.auto_alvo_pct, d.auto_protecao_pct, d.auto_recuo_pct],
  );
  await evento(req.usuarioId, 'estrategia_criada', { estrategia: r[0]!.id, real: d.real });
  // o token só aparece agora; no banco fica só o hash
  res.status(201).json({ id: r[0]!.id, webhook: urlWebhook(t.token) });
});

api.patch('/estrategias/:id', async (req, res) => {
  const estId = id(req);
  const atual = await umOuNada<Estrategia>('select * from estrategias where id = $1', [estId]);
  if (!atual) return void res.status(404).json({ erro: 'estratégia não existe' });
  const d = soEnviados(validar(esquemaEstrategia.omit({ conta_id: true }).partial(), req.body), req.body);
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
            limite_diario = $8, limite_posicao = $9, intervalo_min_seg = $10, desvio_max_pct = $11, ips_permitidos = $12,
            ia_modo = $13, ia_conectores = $14, ia_quorum = $15, ia_falha = $16, ia_confianca_min = $17,
            ia_nas_vendas = $18, ia_contexto = $19, analise_nota_min = $20, analise_validade_h = $21, ia_tipo = $22,
            auto_ligado = $23, auto_stop_pct = $24, auto_alvo_pct = $25, auto_protecao_pct = $26, auto_recuo_pct = $27
      where id = $1`,
    [estId, novo.nome, novo.simbolo, novo.ativa, novo.real, novo.valor_ordem, novo.limite_por_ordem, novo.limite_diario,
      novo.limite_posicao, novo.intervalo_min_seg, novo.desvio_max_pct, novo.ips_permitidos || null,
      novo.ia_modo, novo.ia_conectores, novo.ia_quorum, novo.ia_falha, novo.ia_confianca_min, novo.ia_nas_vendas,
      novo.ia_contexto || null, novo.analise_nota_min, novo.analise_validade_h, novo.ia_tipo,
      novo.auto_ligado, novo.auto_stop_pct, novo.auto_alvo_pct, novo.auto_protecao_pct, novo.auto_recuo_pct],
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
      `select s.id, s.estrategia_id, e.nome as estrategia, s.acao, s.situacao, s.motivo, s.ip, s.corpo, s.recebido_em,
              (select coalesce(json_agg(json_build_object(
                        'conector', p.conector_nome, 'modelo', p.modelo, 'decisao', p.decisao, 'confianca', p.confianca,
                        'motivo', p.motivo, 'erro', p.erro, 'ms', p.ms) order by p.id), '[]'::json)
                 from pareceres_ia p where p.sinal_id = s.id) as pareceres,
              (select json_build_object('etapas', a.etapas, 'decisao', a.decisao, 'confianca', a.confianca, 'motivo', a.motivo, 'ms', a.ms)
                 from agente_execucoes a where a.sinal_id = s.id limit 1) as agente
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

// ------------------------------------------------------------------ conectores de IA

const esquemaConector = z.object({
  nome: z.string().trim().min(1).max(80),
  provedor: z.enum(['anthropic', 'openai']),
  url_base: z.string().trim().max(300).nullable().optional(),
  modelo: z.string().trim().min(1).max(120),
  api_key: textoChave.optional(),
  esforco: z.enum(['low', 'medium', 'high']).default('low'),
  timeout_seg: z.number().int().min(3).max(120).default(25),
  instrucoes: z.string().trim().max(2000).nullable().optional(),
  ativo: z.boolean().default(true),
});

/** A chave vai junto em cada pedido: só https, menos para endereço interno (Ollama da VM, localhost). */
function conferirUrl(provedor: string, url: string | null | undefined): string | null {
  if (provedor === 'anthropic') return null;
  if (!url) throw new ErroPedido('informe a URL base da API (ex. https://api.openai.com/v1)');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ErroPedido('URL base inválida');
  }
  const interno = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || !u.hostname.includes('.');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && interno)) {
    throw new ErroPedido('use https (http só para endereço interno, como o Ollama da VM)');
  }
  if (u.username || u.password) throw new ErroPedido('não ponha usuário e senha na URL; use o campo da chave');
  return u.toString().replace(/\/+$/, '');
}

/** Conector como o painel vê: a chave nunca volta, só se existe. */
function conectorPublico({ api_key_cifrada, ...resto }: ConectorIa) {
  return { ...resto, tem_chave: Boolean(api_key_cifrada) };
}

async function conectoresEscolhidos(ids: number[] | undefined): Promise<ConectorIa[]> {
  const lista = await query<ConectorIa>(
    'select * from conectores_ia where ativo and (cardinality($1::bigint[]) = 0 or id = any($1::bigint[])) order by id',
    [ids ?? []],
  );
  if (!lista.length) throw new ErroPedido('nenhum conector de IA ativo');
  return lista;
}

api.get('/ias/opcoes', (_req, res) => {
  res.json({ claude: MODELOS_CLAUDE, compativeis: PRESETS_COMPATIVEIS });
});

api.get('/ias', async (_req, res) => {
  res.json((await query<ConectorIa>('select * from conectores_ia order by ativo desc, nome')).map(conectorPublico));
});

api.post('/ias', async (req, res) => {
  const d = validar(esquemaConector, req.body);
  const url = conferirUrl(d.provedor, d.url_base);
  if (d.provedor === 'anthropic' && !d.api_key) throw new ErroPedido('o Claude precisa da chave de API da Anthropic');
  const [c] = await query<ConectorIa>(
    `insert into conectores_ia (nome, provedor, url_base, modelo, api_key_cifrada, esforco, timeout_seg, instrucoes, ativo)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [d.nome, d.provedor, url, d.modelo, d.api_key ? cifrar(d.api_key, chave) : null, d.esforco, d.timeout_seg, d.instrucoes || null, d.ativo],
  );
  await evento(req.usuarioId, 'ia_criada', { conector: c!.id, provedor: d.provedor, modelo: d.modelo });
  res.status(201).json(conectorPublico(c!));
});

api.patch('/ias/:id', async (req, res) => {
  const iaId = id(req);
  const atual = await umOuNada<ConectorIa>('select * from conectores_ia where id = $1', [iaId]);
  if (!atual) return void res.status(404).json({ erro: 'conector não existe' });
  const d = soEnviados(validar(esquemaConector.omit({ provedor: true }).partial().extend({ apagar_chave: z.boolean().optional() }), req.body), req.body);
  const url = d.url_base !== undefined ? conferirUrl(atual.provedor, d.url_base) : atual.url_base;
  const novaChave = d.apagar_chave ? null : d.api_key ? cifrar(d.api_key, chave) : atual.api_key_cifrada;
  if (atual.provedor === 'anthropic' && !novaChave) throw new ErroPedido('o Claude precisa da chave de API da Anthropic');
  const [c] = await query<ConectorIa>(
    `update conectores_ia set nome = $2, url_base = $3, modelo = $4, api_key_cifrada = $5, esforco = $6, timeout_seg = $7,
            instrucoes = $8, ativo = $9 where id = $1 returning *`,
    [iaId, d.nome ?? atual.nome, url, d.modelo ?? atual.modelo, novaChave, d.esforco ?? atual.esforco,
      d.timeout_seg ?? atual.timeout_seg, d.instrucoes !== undefined ? d.instrucoes || null : atual.instrucoes, d.ativo ?? atual.ativo],
  );
  await evento(req.usuarioId, 'ia_alterada', {
    conector: iaId,
    campos: Object.keys(d).filter((k) => k !== 'api_key'),
    chave_trocada: Boolean(d.api_key || d.apagar_chave),
  });
  res.json(conectorPublico(c!));
});

api.delete('/ias/:id', async (req, res) => {
  const iaId = id(req);
  await transacao(async (c) => {
    await c.query('update estrategias set ia_conectores = array_remove(ia_conectores, $1::bigint) where $1::bigint = any(ia_conectores)', [iaId]);
    await c.query('delete from conectores_ia where id = $1', [iaId]);
  });
  await evento(req.usuarioId, 'ia_apagada', { conector: iaId });
  res.json({ ok: true });
});

// Cada pergunta às IAs custa dinheiro na conta do provedor: limite curto.
const limiteIa = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

api.post('/ias/:id/testar', limiteIa, async (req, res) => {
  const iaId = id(req);
  const c = await umOuNada<ConectorIa>('select * from conectores_ia where id = $1', [iaId]);
  if (!c) return void res.status(404).json({ erro: 'conector não existe' });
  const r = await pedirParecer(c, PEDIDO_DE_TESTE);
  const teste = { ok: r.ok, ms: r.ms, em: new Date().toISOString(), ...(r.ok ? {} : { erro: r.erro }) };
  await query('update conectores_ia set ultimo_teste = $2 where id = $1', [iaId, JSON.stringify(teste)]);
  res.json(r);
});

api.post('/ias/perguntar', limiteIa, async (req, res) => {
  const d = validar(z.object({ pergunta: z.string().trim().min(2).max(4000), conectores: z.array(z.number().int().positive()).max(20).optional() }), req.body);
  const conectores = await conectoresEscolhidos(d.conectores);
  await evento(req.usuarioId, 'ia_pergunta', { conectores: conectores.map((c) => c.id), tamanho: d.pergunta.length });
  res.json(await perguntarIas(conectores, d.pergunta));
});

/** Parecer avulso (o escritório virtual usa para a reunião com o chefe). Não executa nada. */
api.post('/ias/parecer', limiteIa, async (req, res) => {
  const d = validar(
    z.object({
      simbolo: z.string().trim().min(1).max(40),
      lado: z.enum(['compra', 'venda']),
      cotacao: z.number().positive(),
      valor: z.number().positive().optional(),
      quantidade: z.number().positive().optional(),
      contexto: z.string().trim().max(1000).optional(),
      extras: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).optional(),
      conectores: z.array(z.number().int().positive()).max(20).optional(),
    }),
    req.body,
  );
  const conectores = await conectoresEscolhidos(d.conectores);
  const pedido: PedidoParecer = {
    estrategia: 'escritório virtual (dados fictícios)',
    contexto: d.contexto ?? null,
    simbolo: d.simbolo,
    lado: d.lado,
    modo: 'simulacao',
    ...(d.valor !== undefined ? { valor: d.valor } : {}),
    ...(d.quantidade !== undefined ? { quantidade: d.quantidade } : {}),
    cotacao: d.cotacao,
    posicao: { quantidade: 0, custo_total: 0 },
    gasto_hoje: 0,
    limite_diario: 0,
    ...(d.extras ? { extras: d.extras } : {}),
  };
  res.json(await consultarIas(conectores, pedido));
});

// ------------------------------------------------------------------ análise com 5 agentes

const limiteAnalise = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

api.get('/analises/agentes', (_req, res) => {
  res.json(AGENTES.map(({ id, nome, peso, subnotas }) => ({ id, nome, peso, subnotas })));
});

api.post('/analises', limiteAnalise, async (req, res) => {
  const d = validar(
    z.object({
      simbolo: z.string().trim().toUpperCase().min(1).max(40).regex(/^[A-Z0-9.\-_/:]+$/, 'use BTC/USDT ou um ticker'),
      exchange: z.string().trim().max(40).nullable().optional(),
      conectores: z.array(z.number().int().positive()).max(20).optional(),
      pesquisa_web: z.boolean().default(false),
    }),
    req.body,
  );
  if (d.exchange && !exchangesSuportadas().includes(d.exchange)) throw new ErroPedido(`exchange "${d.exchange}" não suportada`);
  const conectores = await conectoresEscolhidos(d.conectores);
  const id = await iniciarAnalise({
    simbolo: d.simbolo,
    // sem barra não é par de exchange (ex.: PETR4): os agentes trabalham sem as velas
    exchange: d.simbolo.includes('/') ? d.exchange ?? 'binance' : null,
    conectores,
    pesquisaWeb: d.pesquisa_web,
    usuarioId: req.usuarioId,
  });
  await evento(req.usuarioId, 'analise_pedida', { analise: id, simbolo: d.simbolo, conectores: conectores.map((c) => c.id), pesquisa_web: d.pesquisa_web });
  res.status(202).json({ id });
});

api.get('/analises', async (_req, res) => {
  res.json(
    await query(
      `select id, simbolo, exchange, situacao, nota, conceito, sinal, pesquisa_web, criada_em, terminada_em from analises
        order by criada_em desc limit 40`,
    ),
  );
});

api.get('/analises/:id', async (req, res) => {
  const a = await umOuNada('select * from analises where id = $1', [id(req)]);
  if (!a) return void res.status(404).json({ erro: 'análise não existe' });
  res.json(a);
});

// ------------------------------------------------------------------ agente em etapas

const idsEtapas = ETAPAS.map((e) => e.id) as [string, ...string[]];
const esquemaConfigAgente = z.object({
  etapas: z.partialRecord(z.enum(idsEtapas), z.object({ conector_id: z.number().int().positive().nullable().optional(), web: z.boolean().optional(), ligada: z.boolean().optional() })),
});

api.get('/agente', async (_req, res) => {
  const [config, conectores] = await Promise.all([lerConfig(), query<ConectorIa>('select * from conectores_ia order by id')]);
  res.json({
    etapas: ETAPAS.map(({ id, nome, papel, recomendado, usaWeb, kronos }) => ({ id, nome, papel, recomendado, usa_web: Boolean(usaWeb), kronos: Boolean(kronos) })),
    kronos: await saudeKronos(),
    config,
    pronto: agentePronto(config, conectores),
    sugestao: montarAutomatico(conectores),
  });
});

api.get('/kronos', async (_req, res) => {
  res.json(await saudeKronos());
});

api.put('/agente', async (req, res) => {
  const d = validar(esquemaConfigAgente, req.body) as ConfigAgente;
  const ids = Object.values(d.etapas).flatMap((e) => (e?.conector_id ? [e.conector_id] : []));
  if (ids.length) {
    const achados = await query<{ id: number }>('select id from conectores_ia where id = any($1::bigint[])', [ids]);
    if (achados.length !== new Set(ids).size) throw new ErroPedido('algum conector escolhido não existe');
  }
  await salvarConfig(d);
  await evento(req.usuarioId, 'agente_configurado', { etapas: Object.fromEntries(Object.entries(d.etapas).map(([k, v]) => [k, k === 'previsao' ? Boolean(v?.ligada) : v?.conector_id ?? null])) });
  res.json({ ok: true });
});

api.post('/agente/testar', limiteIa, async (req, res) => {
  const d = validar(
    z.object({
      simbolo: z.string().trim().toUpperCase().min(1).max(40),
      lado: z.enum(['compra', 'venda']).default('compra'),
      valor: z.number().positive().default(100),
      exchange: z.string().trim().max(40).nullable().optional(),
      contexto: z.string().trim().max(1000).optional(),
    }),
    req.body,
  );
  if (d.exchange && !exchangesSuportadas().includes(d.exchange)) throw new ErroPedido(`exchange "${d.exchange}" não suportada`);
  const [config, conectores] = await Promise.all([lerConfig(), query<ConectorIa>('select * from conectores_ia where ativo')]);
  if (!agentePronto(config, conectores)) throw new ErroPedido('escolha uma IA ativa para a etapa de decisão');
  let cotacao: number | null = null;
  if (d.exchange && d.simbolo.includes('/')) cotacao = await cotacaoPublica(d.exchange, d.simbolo).catch(() => null);
  const id = await iniciarTeste(
    {
      estrategia: 'teste do painel (nenhuma ordem sai)',
      contexto: d.contexto ?? null,
      simbolo: d.simbolo,
      lado: d.lado,
      modo: 'simulacao',
      ...(d.lado === 'compra' ? { valor: d.valor } : { quantidade: d.valor }),
      cotacao,
      posicao: { quantidade: 0, custo_total: 0 },
      gasto_hoje: 0,
      limite_diario: d.valor * 5,
    },
    d.exchange ?? (d.simbolo.includes('/') ? 'binance' : null),
    conectores,
  );
  await evento(req.usuarioId, 'agente_testado', { execucao: id, simbolo: d.simbolo });
  res.status(202).json({ id });
});

api.get('/agente/execucoes', async (_req, res) => {
  res.json(
    await query(
      `select a.id, a.origem, a.simbolo, a.lado, a.situacao, a.decisao, a.confianca, a.ms, a.criada_em, e.nome as estrategia
         from agente_execucoes a left join estrategias e on e.id = a.estrategia_id order by a.criada_em desc limit 30`,
    ),
  );
});

api.get('/agente/execucoes/:id', async (req, res) => {
  const a = await umOuNada('select * from agente_execucoes where id = $1', [id(req)]);
  if (!a) return void res.status(404).json({ erro: 'execução não existe' });
  res.json(a);
});

// ------------------------------------------------------------------ erros

api.use((err: unknown, _req: Request, res: Response, _next: (e?: unknown) => void) => {
  if (err instanceof ErroPedido) return void res.status(400).json({ erro: err.message });
  throw err;
});
