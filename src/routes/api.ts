import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { apagarSessao, entrar, exigeCabecalhoPainel, exigeLogin, gravarSessao } from '../auth.js';
import { config } from '../config.js';
import { cifrar, derivarChave, novoToken } from '../crypto.js';
import { query, transacao, umOuNada } from '../db.js';
import { corretoraReal, ORIGEM_PAINEL, processarSinalDa, type Conta, type Estrategia } from '../motor.js';
import { B3, cotacaoPublica, exchangesSuportadas, mercadosDa, MT5, paresDaMoeda, velasDiarias } from '../brokers/mercado.js';
import { confirmarAlerta, recusarAlerta } from '../assistente/index.js';
import { desligarTelegram, enviar as enviarTelegram, lerTelegram, salvarToken } from '../assistente/telegram.js';
import { criarPilotoPadrao, POR_MOEDA, POR_MOEDA_REPIQUE } from '../piloto/index.js';
import { PONTE_ONLINE_MS, QUOTEX, type Binaria } from '../binarias/index.js';
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
    tem_chave: Boolean(c.api_key_cifrada && c.api_secret_cifrada) || Boolean(c.ponte_token_hash),
    taxa_simulada_pct: c.taxa_simulada_pct,
    ...(c.exchange === MT5
      ? {
          ponte: {
            token_prefixo: c.ponte_token_prefixo ?? null,
            visto_em: c.ponte_visto_em ?? null,
            // só o que serve para conferir no painel: corretora, servidor e saldo (sem login nem senha)
            corretora: (c.ponte_info?.corretora as string | undefined) ?? null,
            servidor: (c.ponte_info?.servidor as string | undefined) ?? null,
            saldo: (c.ponte_info?.saldo as number | undefined) ?? null,
          },
        }
      : {}),
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
  const contas = await query<Conta>('select * from contas where exchange <> $1 order by nome', [QUOTEX]);
  res.json(contas.map(contaPublica));
});

api.post('/contas', async (req, res) => {
  const d = validar(esquemaConta, req.body);
  if (!exchangesSuportadas().includes(d.exchange)) throw new ErroPedido(`exchange "${d.exchange}" não suportada`);
  const ehMt5 = d.exchange === MT5;
  const ehAssistida = d.exchange === B3;
  if (d.modo === 'real' && !ehMt5 && !ehAssistida && !(d.api_key && d.api_secret)) throw new ErroPedido('conta real precisa de chave e segredo da API');
  // MetaTrader 5 (B3): sem chave de API; a ponte no Windows do dono se identifica com este token
  const ponte = ehMt5 ? novoToken() : null;
  const conta = await transacao(async (c) => {
    const r = await c.query<Conta>(
      `insert into contas (nome, exchange, modo, testnet, api_key_cifrada, api_secret_cifrada, api_senha_cifrada, taxa_simulada_pct,
                           ponte_token_hash, ponte_token_prefixo)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [
        d.nome, d.exchange, d.modo, ehMt5 || ehAssistida ? false : d.testnet,
        !ehMt5 && !ehAssistida && d.api_key ? cifrar(d.api_key, chave) : null,
        !ehMt5 && !ehAssistida && d.api_secret ? cifrar(d.api_secret, chave) : null,
        !ehMt5 && !ehAssistida && d.api_senha ? cifrar(d.api_senha, chave) : null,
        d.taxa_simulada_pct,
        ponte?.hash ?? null,
        ponte?.prefixo ?? null,
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
  if (ehAssistida) {
    // assistente: já sai uma estratégia em simulação, varrendo as ações em velas diárias
    const estrategia = await criarPilotoPadrao(conta.id, `Assistente B3 (${conta.nome})`, 'PETR4/BRL', { tempo: '1d', intervaloMin: 10 });
    return void res.status(201).json({ ...contaPublica(conta), estrategia_criada: estrategia });
  }
  if (!ponte) return void res.status(201).json(contaPublica(conta));
  // na B3, já sai um piloto padrão em simulação varrendo as ações que a ponte acompanha
  const estrategia = await criarPilotoPadrao(conta.id, `Piloto B3 (${conta.nome})`, 'PETR4/BRL');
  // o token da ponte só aparece agora; no banco fica só o hash
  res.status(201).json({ ...contaPublica(conta), estrategia_criada: estrategia, ponte_token: ponte.token, url_bot: config.urlPublica });
});

api.patch('/contas/:id', async (req, res) => {
  const contaId = id(req);
  const d = soEnviados(
    validar(esquemaConta.omit({ saldo_inicial: true, exchange: true }).partial().extend({ apagar_chaves: z.boolean().optional() }), req.body),
    req.body,
  );
  const atual = await umOuNada<Conta>(`select * from contas where id = $1 and exchange <> 'quotex'`, [contaId]);
  if (!atual) return void res.status(404).json({ erro: 'conta não existe' });

  const novaKey = d.apagar_chaves ? null : d.api_key ? cifrar(d.api_key, chave) : atual.api_key_cifrada;
  const novoSecret = d.apagar_chaves ? null : d.api_secret ? cifrar(d.api_secret, chave) : atual.api_secret_cifrada;
  const novaSenha = d.apagar_chaves ? null : d.api_senha ? cifrar(d.api_senha, chave) : atual.api_senha_cifrada;
  const modo = d.modo ?? atual.modo;
  if (modo === 'real' && atual.exchange !== MT5 && atual.exchange !== B3 && !(novaKey && novoSecret)) throw new ErroPedido('conta real precisa de chave e segredo da API');
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
  const conta = await umOuNada<Conta>(`select * from contas where id = $1 and exchange <> 'quotex'`, [id(req)]);
  if (!conta) return void res.status(404).json({ erro: 'conta não existe' });
  const resultado: { publico: string; privado?: string; saldos?: Record<string, number> } = { publico: 'ok' };
  try {
    if (conta.exchange === MT5) {
      // a "cotação pública" da B3 é a que a ponte manda: sem ponte, sem cotação
      if (!Object.keys(await mercadosDa(MT5)).length) throw new Error('a ponte MT5 ainda não mandou cotações (o programa da ponte e o MetaTrader estão abertos?)');
    } else {
      await mercadosDa(conta.exchange);
    }
  } catch (e) {
    resultado.publico = (e as Error).message;
  }
  if (conta.api_key_cifrada || conta.ponte_token_hash) {
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
    auto_varrer: z.boolean().default(false),
    auto_tempo: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).default('1d'),
    auto_intervalo_min: z.number().int().min(1).max(1440).default(2),
    auto_volume_min: z.number().min(0).default(500_000),
    auto_max_ia_dia: z.number().int().min(0).max(100).default(6),
    auto_exigir_virada: z.boolean().default(true),
    auto_estilo: z.enum(['tendencia', 'repique']).default('tendencia'),
  });

function conferirLimites(e: { valor_ordem: number; limite_por_ordem: number; limite_diario: number }): void {
  if (e.valor_ordem > e.limite_por_ordem) throw new ErroPedido('o valor da ordem não pode passar do limite por ordem');
  if (e.limite_por_ordem > e.limite_diario) throw new ErroPedido('o limite por ordem não pode passar do limite diário');
}

async function conferirSimbolo(exchange: string, simbolo: string): Promise<void> {
  moedas(simbolo);
  let mercados;
  try {
    mercados = await mercadosDa(exchange);
  } catch {
    return; // sem acesso à exchange agora: a conferência fica para o primeiro sinal
  }
  // na ponte MT5, a ação pode ainda não estar na lista que ela manda: a ponte passa a acompanhar
  if (exchange !== MT5 && !mercados[simbolo]) throw new ErroPedido(`o par ${simbolo} não existe na ${exchange}`);
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
  const conta = await umOuNada<Conta>(`select * from contas where id = $1 and exchange <> 'quotex'`, [d.conta_id]);
  if (!conta) throw new ErroPedido('conta não existe');
  if (d.real && conta.modo !== 'real') throw new ErroPedido('só dá para marcar como real uma estratégia de conta real');
  await conferirSimbolo(conta.exchange, d.simbolo);
  const t = novoToken();
  const r = await query<Estrategia>(
    `insert into estrategias (nome, conta_id, simbolo, ativa, real, token_hash, token_prefixo, valor_ordem, limite_por_ordem,
                              limite_diario, limite_posicao, intervalo_min_seg, desvio_max_pct, ips_permitidos,
                              ia_modo, ia_conectores, ia_quorum, ia_falha, ia_confianca_min, ia_nas_vendas, ia_contexto,
                              analise_nota_min, analise_validade_h, ia_tipo,
                              auto_ligado, auto_stop_pct, auto_alvo_pct, auto_protecao_pct, auto_recuo_pct,
                              auto_varrer, auto_tempo, auto_intervalo_min, auto_volume_min, auto_max_ia_dia, auto_exigir_virada, auto_estilo)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
             $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36) returning id`,
    [d.nome, d.conta_id, d.simbolo, d.ativa, d.real, t.hash, t.prefixo, d.valor_ordem, d.limite_por_ordem,
      d.limite_diario, d.limite_posicao, d.intervalo_min_seg, d.desvio_max_pct, d.ips_permitidos || null,
      d.ia_modo, d.ia_conectores, d.ia_quorum, d.ia_falha, d.ia_confianca_min, d.ia_nas_vendas, d.ia_contexto || null,
      d.analise_nota_min, d.analise_validade_h, d.ia_tipo,
      d.auto_ligado, d.auto_stop_pct, d.auto_alvo_pct, d.auto_protecao_pct, d.auto_recuo_pct,
      d.auto_varrer, d.auto_tempo, d.auto_intervalo_min, d.auto_volume_min, d.auto_max_ia_dia, d.auto_exigir_virada, d.auto_estilo],
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
            auto_ligado = $23, auto_stop_pct = $24, auto_alvo_pct = $25, auto_protecao_pct = $26, auto_recuo_pct = $27,
            auto_varrer = $28, auto_tempo = $29, auto_intervalo_min = $30, auto_volume_min = $31, auto_max_ia_dia = $32,
            auto_exigir_virada = $33, auto_estilo = $34
      where id = $1`,
    [estId, novo.nome, novo.simbolo, novo.ativa, novo.real, novo.valor_ordem, novo.limite_por_ordem, novo.limite_diario,
      novo.limite_posicao, novo.intervalo_min_seg, novo.desvio_max_pct, novo.ips_permitidos || null,
      novo.ia_modo, novo.ia_conectores, novo.ia_quorum, novo.ia_falha, novo.ia_confianca_min, novo.ia_nas_vendas,
      novo.ia_contexto || null, novo.analise_nota_min, novo.analise_validade_h, novo.ia_tipo,
      novo.auto_ligado, novo.auto_stop_pct, novo.auto_alvo_pct, novo.auto_protecao_pct, novo.auto_recuo_pct,
      novo.auto_varrer, novo.auto_tempo, novo.auto_intervalo_min, novo.auto_volume_min, novo.auto_max_ia_dia,
      novo.auto_exigir_virada, novo.auto_estilo],
  );
  await evento(req.usuarioId, 'estrategia_alterada', { estrategia: estId, mudou: d });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ assistente (Telegram e avisos)

api.get('/telegram', async (_req, res) => {
  const t = await lerTelegram();
  res.json(t ? { configurado: true, bot: t.bot, pareado: Boolean(t.chat_id), codigo: t.codigo } : { configurado: false });
});

api.put('/telegram', async (req, res) => {
  const { token } = validar(z.object({ token: z.string().trim().regex(/^\d{5,15}:[A-Za-z0-9_-]{20,80}$/, 'token do @BotFather no formato 123456:ABC…') }), req.body);
  const r = await salvarToken(token).catch((e: Error) => {
    throw new ErroPedido(e.message);
  });
  await evento(req.usuarioId, 'telegram_configurado', { bot: r.bot });
  res.json({ configurado: true, bot: r.bot, pareado: false, codigo: r.codigo });
});

api.delete('/telegram', async (req, res) => {
  await desligarTelegram();
  await evento(req.usuarioId, 'telegram_desligado', {});
  res.json({ configurado: false });
});

api.post('/telegram/testar', async (_req, res) => {
  const msg = await enviarTelegram('🔔 Teste do Bot Financeiro: os avisos do assistente chegam aqui.').catch((e: Error) => {
    throw new ErroPedido(e.message);
  });
  if (!msg) throw new ErroPedido('o Telegram ainda não está pareado: mande /start com o código para o seu bot');
  res.json({ ok: true });
});

api.get('/alertas', async (req, res) => {
  const f = validar(z.object({ limite: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  res.json(
    await query(
      `select a.*, e.nome as estrategia from alertas a join estrategias e on e.id = a.estrategia_id
        order by (a.situacao = 'pendente') desc, a.id desc limit $1`,
      [f.limite],
    ),
  );
});

api.post('/alertas/:id/confirmar', async (req, res) => {
  const d = validar(z.object({ preco: z.number().positive().optional(), quantidade: z.number().positive().optional() }), req.body ?? {});
  const r = await confirmarAlerta(id(req), d);
  if (!r.ok) throw new ErroPedido(r.texto);
  await evento(req.usuarioId, 'alerta_confirmado', { alerta: id(req), ...d });
  res.json(r);
});

api.post('/alertas/:id/recusar', async (req, res) => {
  const r = await recusarAlerta(id(req));
  if (!r.ok) throw new ErroPedido(r.texto);
  await evento(req.usuarioId, 'alerta_recusado', { alerta: id(req) });
  res.json(r);
});

// ------------------------------------------------------------------ ordem manual e uma estratégia por moeda

/**
 * Ordem do dono pelo painel (botões Comprar e Vender): o mesmo caminho do webhook e do piloto, com
 * as regras de risco, os limites e as três chaves do dinheiro real. Só não passa pela IA: a decisão é dele.
 */
api.post('/estrategias/:id/ordem', async (req, res) => {
  const d = validar(z.object({ acao: z.enum(['comprar', 'vender', 'zerar']), valor: z.number().positive().optional(), quantidade: z.number().positive().optional() }), req.body);
  const r = await processarSinalDa(id(req), { ...d, id: `painel-${Date.now()}` }, ORIGEM_PAINEL);
  if (r.status === 404) return void res.status(404).json({ erro: 'estratégia não existe' });
  await evento(req.usuarioId, 'ordem_manual', { estrategia: id(req), ...d, situacao: r.situacao });
  res.json({ situacao: r.situacao, motivo: r.motivo ?? null });
});

/**
 * Cria, numa conta, uma estratégia de piloto para cada par da moeda com volume que ainda não tem
 * estratégia (ex.: todos os pares em BRL da Binance). Saem em SIMULAÇÃO: operar real é um passo do dono.
 */
api.post('/estrategias/todas-as-moedas', async (req, res) => {
  const d = validar(z.object({ conta_id: z.number().int().positive(), moeda: z.string().trim().toUpperCase().min(2).max(10).default('BRL'), estilo: z.enum(['tendencia', 'repique']).default('repique') }), req.body);
  const conta = await umOuNada<Conta>(`select * from contas where id = $1 and exchange <> 'quotex'`, [d.conta_id]);
  if (!conta) throw new ErroPedido('conta não existe');
  const pares = await paresDaMoeda(conta.exchange, d.moeda, 500_000).catch((e: Error) => {
    throw new ErroPedido(`não consegui listar os pares da ${conta.exchange}: ${e.message}`.slice(0, 200));
  });
  const existentes = new Set((await query<{ simbolo: string }>('select simbolo from estrategias where conta_id = $1', [conta.id])).map((e) => e.simbolo));
  const criadas: string[] = [];
  for (const p of pares.slice(0, 30)) {
    if (existentes.has(p.simbolo)) continue;
    const base = d.estilo === 'repique' ? POR_MOEDA_REPIQUE : POR_MOEDA;
    await criarPilotoPadrao(conta.id, `Piloto ${p.simbolo.split('/')[0]}`, p.simbolo, conta.exchange === B3 ? { ...base, tempo: '1d', intervaloMin: 10 } : base);
    criadas.push(p.simbolo);
  }
  await evento(req.usuarioId, 'estrategias_por_moeda', { conta: conta.id, criadas });
  res.status(201).json({ criadas, ja_existiam: pares.length - criadas.length });
});

/** Token novo da ponte MetaTrader 5; o antigo para de valer na hora. */
api.post('/contas/:id/novo-token-ponte', async (req, res) => {
  const contaId = id(req);
  const t = novoToken();
  const r = await query('update contas set ponte_token_hash = $2, ponte_token_prefixo = $3 where id = $1 and exchange = $4 returning id', [contaId, t.hash, t.prefixo, MT5]);
  if (!r.length) return void res.status(404).json({ erro: 'conta MetaTrader 5 não existe' });
  await evento(req.usuarioId, 'token_ponte_trocado', { conta: contaId });
  res.json({ ponte_token: t.token, url_bot: config.urlPublica });
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

// ------------------------------------------------------------------ escritório ao vivo
//
// O escritório virtual mostra o bot de verdade: um robô por estratégia, com a cotação real, as velas
// diárias (para o monitor da mesa) e os últimos sinais (cada um vira uma reunião com o chefe). Só lê.

const velasCache = new Map<string, { ate: number; velas: Promise<{ t: number; abre: number; fecha: number }[]> }>();
function velasComCache(exchange: string, simbolo: string) {
  const chave = `${exchange}|${simbolo}`;
  const atual = velasCache.get(chave);
  if (atual && atual.ate > Date.now()) return atual.velas;
  const velas = velasDiarias(exchange, simbolo, 130);
  velasCache.set(chave, { ate: Date.now() + 30 * 60_000, velas });
  velas.catch(() => velasCache.delete(chave));
  return velas;
}

api.get('/escritorio', async (_req, res) => {
  const estrategias = await query<{
    id: number; nome: string; simbolo: string; exchange: string; ativa: boolean; real: boolean; conta_modo: string;
    auto_ligado: boolean; auto_situacao: string | null; auto_checado_em: Date | null; ia_modo: string; ia_tipo: string;
    valor_ordem: number; posicao: number; custo_posicao: number; auto_varrer: boolean;
    auto_varredura: { simbolo: string; preco: number | null; variacao_pct: number | null; motivo: string; virou: boolean }[] | null;
  }>(
    `select e.id, e.nome, e.simbolo, c.exchange, e.ativa, e.real, c.modo as conta_modo, e.auto_ligado, e.auto_situacao,
            e.auto_checado_em, e.ia_modo, e.ia_tipo, e.valor_ordem, e.auto_varrer, e.auto_varredura,
            coalesce(p.quantidade, 0) as posicao, coalesce(p.custo_total, 0) as custo_posicao
       from estrategias e join contas c on c.id = e.conta_id left join posicoes p on p.estrategia_id = e.id
      order by e.ativa desc, e.id`,
  );
  const comMercado = await Promise.all(
    estrategias.map(async (e) => {
      const [preco, velas] = await Promise.allSettled([cotacaoPublica(e.exchange, e.simbolo), velasComCache(e.exchange, e.simbolo)]);
      const lista = velas.status === 'fulfilled' ? velas.value : [];
      // varredura do piloto: um "olheiro" por par (até 7), com as velas diárias para o monitor
      const olhados = e.auto_ligado && e.auto_varrer ? (e.auto_varredura ?? []).filter((o) => o.simbolo !== e.simbolo).slice(0, 7) : [];
      const pares = await Promise.all(
        olhados.map(async (o) => {
          const v = await velasComCache(e.exchange, o.simbolo).catch(() => []);
          return { ...o, abertura_hoje: v[v.length - 1]?.abre ?? null, fechamentos: v.slice(0, -1).map((x) => x.fecha) };
        }),
      );
      return {
        ...e,
        pares,
        motivo_par: (e.auto_varredura ?? []).find((o) => o.simbolo === e.simbolo)?.motivo ?? null,
        operando_real: e.real && e.conta_modo === 'real' && config.realLiberadoNoServidor,
        preco: preco.status === 'fulfilled' ? preco.value : null,
        abertura_hoje: lista[lista.length - 1]?.abre ?? null,
        fechamentos: lista.slice(0, -1).map((v) => v.fecha),
      };
    }),
  );
  const sinais = await query(
    `select s.id, s.estrategia_id, s.acao, s.situacao, s.motivo, s.ip, s.recebido_em, s.corpo->>'id' as id_externo,
            s.corpo->>'simbolo' as simbolo,
            (select json_build_object('etapas', a.etapas, 'decisao', a.decisao, 'confianca', a.confianca, 'motivo', a.motivo)
               from agente_execucoes a where a.sinal_id = s.id limit 1) as agente,
            (select coalesce(json_agg(json_build_object('conector', p.conector_nome, 'decisao', p.decisao, 'confianca', p.confianca,
                                                         'erro', p.erro) order by p.id), '[]'::json)
               from pareceres_ia p where p.sinal_id = s.id) as pareceres,
            (select json_build_object('lado', o.lado, 'modo', o.modo, 'preco', o.preco_medio, 'custo', o.custo, 'quantidade', o.quantidade)
               from ordens o where o.sinal_id = s.id and o.situacao = 'executada' limit 1) as ordem
       from sinais s where s.estrategia_id is not null
      order by s.id desc limit 30`,
  );
  res.json({ real_no_servidor: config.realLiberadoNoServidor, estrategias: comMercado, sinais });
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

// ------------------------------------------------------------------ opções binárias (Quotex)
//
// A conta "quotex" mora na tabela contas (modo simulação = conta demo da Quotex), mas é cuidada só
// por aqui: não tem chave de API, e sim o token da ponte que roda no computador do dono.

const esquemaBinaria = z.object({
  nome: z.string().trim().min(1).max(80),
  conta_id: z.number().int().positive(),
  ativo: z.string().trim().regex(/^[A-Za-z0-9_#.-]{2,40}$/, 'ativo inválido'),
  ativa: z.boolean().default(false),
  real: z.boolean().default(false),
  estilo: z.enum(['repique', 'tendencia']).default('repique'),
  prazo_s: z.union([z.literal(60), z.literal(120), z.literal(180), z.literal(300)]).default(300),
  valor: z.number().positive().max(10_000),
  payout_min: z.number().min(50).max(100).default(85),
  max_apostas_dia: z.number().int().min(1).max(200).default(10),
  perda_max_dia: z.number().positive().max(100_000),
  perdas_seguidas_max: z.number().int().min(1).max(20).default(3),
  intervalo_min_seg: z.number().int().min(0).max(86_400).default(300),
});

function contaQuotex(c: Conta) {
  const info = c.ponte_info ?? {};
  return {
    id: c.id,
    nome: c.nome,
    modo: c.modo,
    token_prefixo: c.ponte_token_prefixo ?? null,
    visto_em: c.ponte_visto_em ?? null,
    online: Boolean(c.ponte_visto_em && Date.now() - new Date(c.ponte_visto_em).getTime() < PONTE_ONLINE_MS),
    // em que conta da Quotex a ponte está logada e o saldo dela (sem e-mail nem senha: eles não vêm para cá)
    conta: (info.conta as string | undefined) ?? null,
    saldo: (info.saldo as number | undefined) ?? null,
    moeda: (info.moeda as string | undefined) ?? null,
  };
}

api.get('/binarias', async (_req, res) => {
  const [contas, estrategias, apostas, mercado] = await Promise.all([
    query<Conta>('select * from contas where exchange = $1 order by nome', [QUOTEX]),
    query(
      `select b.*, c.nome as conta, c.modo as conta_modo,
              coalesce(h.apostas, 0)::int as apostas_hoje, coalesce(h.lucro, 0) as lucro_hoje,
              coalesce(t.ganhou, 0)::int as ganhou, coalesce(t.perdeu, 0)::int as perdeu, coalesce(t.lucro, 0) as lucro_total
         from binarias b join contas c on c.id = b.conta_id
         left join lateral (
           select count(*) filter (where situacao not in ('erro', 'expirada')) as apostas, sum(lucro) as lucro from apostas
            where binaria_id = b.id and criada_em >= (date_trunc('day', now() at time zone $1) at time zone $1)) h on true
         left join lateral (
           select count(*) filter (where situacao = 'ganhou') as ganhou, count(*) filter (where situacao = 'perdeu') as perdeu, sum(lucro) as lucro
             from apostas where binaria_id = b.id) t on true
        order by b.nome`,
      [config.fuso],
    ),
    query(
      `select a.id, a.binaria_id, b.nome as estrategia, a.modo, a.ativo, a.direcao, a.valor, a.prazo_s, a.payout, a.motivo,
              a.situacao, a.lucro, a.erro, a.criada_em, a.terminada_em
         from apostas a join binarias b on b.id = a.binaria_id order by a.criada_em desc limit 60`,
    ),
    query(
      `select ativo, nome, aberto, payout_1m, payout_5m, atualizado_em, jsonb_array_length(velas) as velas
         from quotex_mercado where atualizado_em > now() - interval '15 minutes'
        order by aberto desc, coalesce(payout_5m, payout_1m, 0) desc, ativo limit 300`,
    ),
  ]);
  res.json({ real_no_servidor: config.realLiberadoNoServidor, contas: contas.map(contaQuotex), estrategias, apostas, mercado });
});

api.post('/binarias/contas', async (req, res) => {
  const d = validar(z.object({ nome: z.string().trim().min(1).max(80) }), req.body);
  const t = novoToken();
  const r = await query<Conta>(
    `insert into contas (nome, exchange, modo, ponte_token_hash, ponte_token_prefixo) values ($1, $2, 'simulacao', $3, $4) returning *`,
    [d.nome, QUOTEX, t.hash, t.prefixo],
  );
  const conta = r[0]!;
  await evento(req.usuarioId, 'conta_criada', { conta: conta.id, exchange: QUOTEX, modo: conta.modo });
  // já sai uma estratégia desligada, para a ponte começar a mandar as velas do ativo
  await query(
    `insert into binarias (nome, conta_id, ativo, valor, perda_max_dia) values ($1, $2, 'EURUSD_otc', 5, 15)`,
    [`Binárias EUR/USD (${conta.nome})`, conta.id],
  );
  // o token só aparece agora; no banco fica só o hash
  res.status(201).json({ ...contaQuotex(conta), ponte_token: t.token, url_bot: config.urlPublica });
});

api.patch('/binarias/contas/:id', async (req, res) => {
  const contaId = id(req);
  const d = soEnviados(validar(z.object({ nome: z.string().trim().min(1).max(80), modo: z.enum(['simulacao', 'real']) }).partial(), req.body), req.body);
  const atual = await umOuNada<Conta>('select * from contas where id = $1 and exchange = $2', [contaId, QUOTEX]);
  if (!atual) return void res.status(404).json({ erro: 'conta da Quotex não existe' });
  const modo = d.modo ?? atual.modo;
  // conta voltou para demo: nenhuma estratégia dela pode continuar marcada como real
  if (modo === 'simulacao') await query('update binarias set real = false where conta_id = $1 and real', [contaId]);
  const r = await query<Conta>('update contas set nome = $2, modo = $3 where id = $1 returning *', [contaId, d.nome ?? atual.nome, modo]);
  await evento(req.usuarioId, 'conta_alterada', { conta: contaId, campos: Object.keys(d), modo_antes: atual.modo, modo_depois: modo });
  res.json(contaQuotex(r[0]!));
});

api.post('/binarias/contas/:id/novo-token', async (req, res) => {
  const contaId = id(req);
  const t = novoToken();
  const r = await query('update contas set ponte_token_hash = $2, ponte_token_prefixo = $3 where id = $1 and exchange = $4 returning id', [contaId, t.hash, t.prefixo, QUOTEX]);
  if (!r.length) return void res.status(404).json({ erro: 'conta da Quotex não existe' });
  await evento(req.usuarioId, 'token_ponte_trocado', { conta: contaId });
  res.json({ ponte_token: t.token, url_bot: config.urlPublica });
});

api.post('/binarias', async (req, res) => {
  const d = validar(esquemaBinaria, req.body);
  const conta = await umOuNada<Conta>('select * from contas where id = $1 and exchange = $2', [d.conta_id, QUOTEX]);
  if (!conta) throw new ErroPedido('escolha uma conta da Quotex');
  if (d.real && conta.modo !== 'real') throw new ErroPedido('só dá para marcar como real uma estratégia de conta real');
  if (d.valor > d.perda_max_dia) throw new ErroPedido('a perda máxima do dia tem de ser pelo menos o valor de uma aposta');
  const r = await query<{ id: number }>(
    `insert into binarias (nome, conta_id, ativo, ativa, real, estilo, prazo_s, valor, payout_min, max_apostas_dia, perda_max_dia,
                           perdas_seguidas_max, intervalo_min_seg)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [d.nome, d.conta_id, d.ativo, d.ativa, d.real, d.estilo, d.prazo_s, d.valor, d.payout_min, d.max_apostas_dia, d.perda_max_dia,
      d.perdas_seguidas_max, d.intervalo_min_seg],
  );
  await evento(req.usuarioId, 'binaria_criada', { binaria: r[0]!.id, real: d.real });
  res.status(201).json({ id: r[0]!.id });
});

api.patch('/binarias/:id', async (req, res) => {
  const binId = id(req);
  const d = soEnviados(validar(esquemaBinaria.omit({ conta_id: true }).partial(), req.body), req.body);
  const atual = await umOuNada<Binaria & { conta_modo: string }>(
    'select b.*, c.modo as conta_modo from binarias b join contas c on c.id = b.conta_id where b.id = $1',
    [binId],
  );
  if (!atual) return void res.status(404).json({ erro: 'estratégia não existe' });
  const novo = { ...atual, ...d };
  if (novo.real && atual.conta_modo !== 'real') throw new ErroPedido('só dá para marcar como real uma estratégia de conta real');
  if (Number(novo.valor) > Number(novo.perda_max_dia)) throw new ErroPedido('a perda máxima do dia tem de ser pelo menos o valor de uma aposta');
  await query(
    `update binarias set nome = $2, ativo = $3, ativa = $4, real = $5, estilo = $6, prazo_s = $7, valor = $8, payout_min = $9,
            max_apostas_dia = $10, perda_max_dia = $11, perdas_seguidas_max = $12, intervalo_min_seg = $13 where id = $1`,
    [binId, novo.nome, novo.ativo, novo.ativa, novo.real, novo.estilo, novo.prazo_s, novo.valor, novo.payout_min, novo.max_apostas_dia,
      novo.perda_max_dia, novo.perdas_seguidas_max, novo.intervalo_min_seg],
  );
  await evento(req.usuarioId, 'binaria_alterada', { binaria: binId, campos: Object.keys(d), real_antes: atual.real, real_depois: novo.real });
  res.json({ ok: true });
});

api.delete('/binarias/:id', async (req, res) => {
  const binId = id(req);
  const [uso] = await query<{ n: number }>('select count(*)::int as n from apostas where binaria_id = $1', [binId]);
  if (uso && uso.n > 0) throw new ErroPedido('esta estratégia já tem apostas no histórico: desative em vez de apagar');
  const r = await query('delete from binarias where id = $1 returning id', [binId]);
  if (!r.length) return void res.status(404).json({ erro: 'estratégia não existe' });
  await evento(req.usuarioId, 'binaria_apagada', { binaria: binId });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ erros

api.use((err: unknown, _req: Request, res: Response, _next: (e?: unknown) => void) => {
  if (err instanceof ErroPedido) return void res.status(400).json({ erro: err.message });
  throw err;
});
