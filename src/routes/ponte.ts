import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { hashToken } from '../crypto.js';
import { query, transacao, umOuNada } from '../db.js';
import { logger } from '../logger.js';
import { observarMt5, ORDEM_EXPIRA_S, paraBot, paraMt5, MT5 } from '../brokers/mt5.js';

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

ponte.post(
  '/sincronizar',
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }),
  express.json({ limit: '4mb' }),
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
      if (!feito.length) logger.warn({ comando: r.id, conta: conta.id }, 'ponte MT5 respondeu uma ordem que não estava esperando resposta');
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
