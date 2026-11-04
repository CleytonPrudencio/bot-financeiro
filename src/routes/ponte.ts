import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { hashToken } from '../crypto.js';
import { query, transacao, umOuNada } from '../db.js';
import { logger } from '../logger.js';
import { observarMt5, ORDEM_EXPIRA_S, paraBot, paraMt5, MT5, SEM_RESPOSTA } from '../brokers/mt5.js';
import { atualizarPosicao } from '../motor.js';
import { QUOTEX, sincronizarPonte } from '../binarias/index.js';

// POST /ponte/sincronizar: a ponte MetaTrader 5 (no Windows do dono) liga para cá a cada 1 a 2 s.
// Manda cotações, velas, o saldo e o resultado das ordens que executou; leva a lista de ações para
// acompanhar e as ordens pendentes. Quem autoriza é o token da conta MT5 (Authorization: Bearer).
//
// A ponte nunca decide nada: ela só recebe ordens que já passaram pelas regras de risco, pelo agente
// e pelas três chaves do dinheiro real (processarSinal). Ordem que esperou mais de 30 s expira.

export const ponte = Router();

const numero = z.number().finite();
const vela = z.array(numero).min(5).max(6);
const esquema = z.object({
  versao: z.string().max(20).optional(),
  conta: z
    .object({
      corretora: z.string().max(120).optional(),
      servidor: z.string().max(120).optional(),
      moeda: z.string().max(10).optional(),
      saldo: numero.optional(),
      saldo_livre: numero.optional(),
      posicoes: z.record(z.string().max(20), numero).optional(),
    })
    .optional(),
  mercado: z
    .array(
      z.object({
        simbolo: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,12}$/),
        cotacao: numero.positive().nullable().optional(),
        volume_financeiro: numero.min(0).nullable().optional(),
        // partialRecord: no zod 4, record com chaves de enum exige todas
        velas: z.partialRecord(z.enum(['1m', '5m', '15m', '1h', '4h', '1d']), z.array(vela).max(600)).optional(),
      }),
    )
    .max(60)
    .optional(),
  resultados: z
    .array(
      z.object({
        id: z.number().int().positive(),
        ok: z.boolean(),
        preco: numero.positive().optional(),
        quantidade: numero.min(0).optional(),
        id_exchange: z.string().max(80).nullable().optional(),
        erro: z.string().max(500).optional(),
      }),
    )
    .max(50)
    .optional(),
});

/**
 * A resposta de uma ordem chegou depois que o bot desistiu de esperar (ele gravou a ordem como erro
 * "pegou e não respondeu"). Se a corretora executou, a ordem e a posição passam a valer agora: senão a
 * ação ficava comprada no MetaTrader sem o bot saber (sem stop, sem alvo). Devolve true se tratou.
 */
async function conciliarAtrasada(contaId: number, r: { id: number; ok: boolean; preco?: number | undefined; quantidade?: number | undefined; id_exchange?: string | null | undefined; erro?: string | undefined }): Promise<boolean> {
  const [cmd] = await query<{ dados: { lado: 'compra' | 'venda'; simbolo: string; preco_ref: number }; criado_em: Date }>(
    `select dados, criado_em from mt5_comandos where id = $1 and conta_id = $2 and situacao = 'erro' and (resultado->>'sem_resposta')::boolean`,
    [r.id, contaId],
  );
  if (!cmd) return false;
  await query(`update mt5_comandos set situacao = $3, resultado = $4, terminado_em = now() where id = $1 and conta_id = $2`, [
    r.id, contaId, r.ok ? 'feito' : 'erro', JSON.stringify({ ...r, chegou_atrasada: true }),
  ]);
  if (!r.ok || !(Number(r.quantidade) > 0)) {
    logger.warn({ comando: r.id, conta: contaId, erro: r.erro }, 'ponte MT5: a ordem sem resposta não foi executada (resposta atrasada)');
    return true;
  }
  const quantidade = Number(r.quantidade);
  const preco = Number(r.preco ?? cmd.dados.preco_ref);
  // a corretora executou: o log é a prova, antes de qualquer gravação
  logger.info({ comando: r.id, conta: contaId, ...cmd.dados, quantidade, preco, id_exchange: r.id_exchange ?? null }, 'ordem executada (resposta atrasada da ponte MT5)');
  const [ordem] = await query<{ id: number; estrategia_id: number; sinal_id: number | null }>(
    `select id, estrategia_id, sinal_id from ordens
      where conta_id = $1 and simbolo = $2 and lado = $3 and situacao = 'erro' and erro like $4
        and criada_em between $5 and $5::timestamptz + interval '5 minutes'
      order by criada_em limit 1`,
    [contaId, cmd.dados.simbolo, cmd.dados.lado, `${SEM_RESPOSTA}%`, cmd.criado_em],
  );
  if (!ordem) {
    logger.error({ comando: r.id, conta: contaId, ...cmd.dados }, 'ponte MT5: ordem executada sem a ordem do bot para conciliar; confira no MetaTrader');
    return true;
  }
  await transacao(async (c) => {
    await c.query('select pg_advisory_xact_lock(1, $1::int)', [ordem.estrategia_id]);
    const pos = (await c.query<{ quantidade: number; custo_total: number }>('select quantidade, custo_total from posicoes where estrategia_id = $1', [ordem.estrategia_id])).rows[0];
    const exec = { quantidade, precoMedio: preco, custo: quantidade * preco, taxa: 0, idExchange: r.id_exchange ?? null };
    await c.query(
      `update ordens set situacao = 'executada', quantidade = $2, preco_medio = $3, custo = $4, id_exchange = $5,
              erro = 'executada depois: a ponte respondeu atrasada' where id = $1`,
      [ordem.id, quantidade, preco, exec.custo, exec.idExchange],
    );
    await atualizarPosicao(c, ordem.estrategia_id, cmd.dados.lado, exec, { quantidade: Number(pos?.quantidade ?? 0), custo_total: Number(pos?.custo_total ?? 0) });
    if (ordem.sinal_id) {
      await c.query(`update sinais set situacao = 'executado', motivo = 'executada depois: a ponte respondeu atrasada' where id = $1`, [ordem.sinal_id]);
    }
  });
  return true;
}

ponte.post(
  '/sincronizar',
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }),
  express.json({ limit: '8mb' }),
  async (req, res) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (token.length < 20 || token.length > 100) return void res.status(401).json({ erro: 'token da ponte ausente' });
    const conta = await umOuNada<{ id: number }>('select id from contas where ponte_token_hash = $1 and exchange = $2', [hashToken(token), MT5]);
    if (!conta) return void res.status(401).json({ erro: 'token da ponte inválido' });
    const lido = esquema.safeParse(req.body);
    if (!lido.success) return void res.status(400).json({ erro: `corpo inválido: ${lido.error.issues[0]?.path.join('.') ?? '?'}` });
    const d = lido.data;

    await query(
      `update contas set ponte_visto_em = now(), ponte_info = coalesce($2::jsonb, ponte_info) where id = $1`,
      [conta.id, d.conta ? JSON.stringify({ ...d.conta, versao: d.versao ?? null }) : null],
    );
    for (const m of d.mercado ?? []) {
      // velas novas substituem as daquele tempo; os outros tempos ficam como estavam
      await query(
        `insert into mt5_mercado (simbolo, cotacao, volume_financeiro, velas, atualizado_em) values ($1, $2, $3, $4, now())
         on conflict (simbolo) do update set cotacao = coalesce($2, mt5_mercado.cotacao),
           volume_financeiro = coalesce($3, mt5_mercado.volume_financeiro), velas = mt5_mercado.velas || $4, atualizado_em = now()`,
        [paraBot(m.simbolo), m.cotacao ?? null, m.volume_financeiro ?? null, JSON.stringify(m.velas ?? {})],
      );
    }
    for (const r of d.resultados ?? []) {
      const feito = await query(
        `update mt5_comandos set situacao = $3, resultado = $4, terminado_em = now()
          where id = $1 and conta_id = $2 and situacao = 'enviado' returning id`,
        [r.id, conta.id, r.ok ? 'feito' : 'erro', JSON.stringify(r)],
      );
      if (!feito.length && !(await conciliarAtrasada(conta.id, r))) {
        logger.warn({ comando: r.id, conta: conta.id }, 'ponte MT5 respondeu uma ordem que não estava esperando resposta');
      }
    }

    // ordens pendentes desta conta: as que esperaram demais expiram; as outras vão para a ponte
    const comandos = await transacao(async (c) => {
      await c.query(
        `update mt5_comandos set situacao = 'expirado', terminado_em = now()
          where conta_id = $1 and situacao = 'pendente' and criado_em < now() - make_interval(secs => $2)`,
        [conta.id, ORDEM_EXPIRA_S],
      );
      const r = await c.query<{ id: number; dados: { lado: string; simbolo: string; quantidade: number; preco_ref: number }; idade_s: number }>(
        `update mt5_comandos set situacao = 'enviado', enviado_em = now()
          where id in (select id from mt5_comandos where conta_id = $1 and situacao = 'pendente' order by id for update skip locked)
          returning id, dados, extract(epoch from now() - criado_em)::float as idade_s`,
        [conta.id],
      );
      return r.rows;
    });
    for (const c of comandos) logger.info({ comando: c.id, conta: conta.id, ...c.dados }, 'ordem entregue à ponte MT5');

    const observar = await observarMt5();
    res.json({
      observar: observar.simbolos,
      tempos: observar.tempos,
      comandos: comandos.map((c) => ({
        id: c.id,
        lado: c.dados.lado,
        simbolo: paraMt5(c.dados.simbolo),
        quantidade: c.dados.quantidade,
        preco_ref: c.dados.preco_ref,
        idade_s: c.idade_s,
      })),
    });
  },
);

// ------------------------------------------------------------------ ponte Quotex (opções binárias)
//
// POST /ponte/quotex: a ponte da Quotex (public/ponte-quotex/ponte.py, no computador do dono) liga
// para cá a cada 2 s. Manda a conta em que está logada (demo ou real) e o saldo, os ativos com
// payout, as velas de 1 min dos ativos das estratégias e o que aconteceu com as apostas; leva as
// apostas pendentes, que já passaram por `avaliarAposta` (src/risco.ts). A senha da Quotex fica só
// no computador do dono: aqui chega o token da conta (Authorization: Bearer).

const velaQuotex = z.array(numero).min(5).max(6);
const esquemaQuotex = z.object({
  versao: z.string().max(20).optional(),
  conta: z
    .object({
      conta: z.enum(['demo', 'real']),
      saldo: numero.min(0).optional(),
      moeda: z.string().max(10).optional(),
    })
    .optional(),
  mercado: z
    .array(
      z.object({
        ativo: z.string().trim().regex(/^[A-Za-z0-9_#.-]{2,40}$/),
        nome: z.string().max(80).optional(),
        aberto: z.boolean(),
        payout_1m: numero.min(0).max(100).nullable().optional(),
        payout_5m: numero.min(0).max(100).nullable().optional(),
        velas: z.array(velaQuotex).max(300).optional(),
      }),
    )
    .max(400)
    .optional(),
  abertas: z
    .array(z.object({ id: z.number().int().positive(), ok: z.boolean(), id_quotex: z.string().max(80).optional(), erro: z.string().max(500).optional() }))
    .max(50)
    .optional(),
  fechadas: z
    .array(z.object({ id: z.number().int().positive(), resultado: z.enum(['ganhou', 'perdeu', 'empate']), retorno: numero.optional() }))
    .max(50)
    .optional(),
});

ponte.post(
  '/quotex',
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }),
  express.json({ limit: '2mb' }),
  async (req, res) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (token.length < 20 || token.length > 100) return void res.status(401).json({ erro: 'token da ponte ausente' });
    const conta = await umOuNada<{ id: number }>('select id from contas where ponte_token_hash = $1 and exchange = $2', [hashToken(token), QUOTEX]);
    if (!conta) return void res.status(401).json({ erro: 'token da ponte inválido' });
    const lido = esquemaQuotex.safeParse(req.body);
    if (!lido.success) return void res.status(400).json({ erro: `corpo inválido: ${lido.error.issues[0]?.path.join('.') ?? '?'}` });
    res.json(await sincronizarPonte(conta.id, lido.data));
  },
);
