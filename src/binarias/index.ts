import type pg from 'pg';
import { config } from '../config.js';
import { query, transacao } from '../db.js';
import { logger } from '../logger.js';
import { avaliarAposta, lucroDaAposta, type DecisaoAposta } from '../risco.js';
import { lerSinal, payoutDoPrazo, perdasSeguidas, velasQuotex, type Direcao } from './regras.js';

// Opções binárias na Quotex, pela ponte no Windows do dono (public/ponte-quotex/ponte.py).
// A cada 10 s olha as estratégias ativas: com uma vela de 1 min nova fechada, lê o sinal e, se der
// call ou put, pede a aposta. O pedido passa por `avaliarAposta` (src/risco.ts) dentro da trava da
// estratégia e vira uma linha "pendente" em `apostas`; a ponte leva, aposta e devolve o resultado.
//
// A ponte nunca decide nada. O bot nunca aumenta a aposta depois de perder.

export const QUOTEX = 'quotex';
/** A ponte sincroniza a cada 2 s; sem notícia dela há mais que isto, está desligada. */
export const PONTE_ONLINE_MS = 30_000;
/** Tempo para a ponte pegar a aposta; depois disso ela expira (o sinal já ficou velho). */
export const APOSTA_EXPIRA_S = 20;
const INTERVALO_MS = 10_000;

export interface Binaria {
  id: number;
  nome: string;
  conta_id: number;
  ativo: string;
  ativa: boolean;
  real: boolean;
  estilo: 'repique' | 'tendencia';
  prazo_s: number;
  valor: string | number;
  payout_min: string | number;
  max_apostas_dia: number;
  perda_max_dia: string | number;
  perdas_seguidas_max: number;
  intervalo_min_seg: number;
  situacao: string | null;
  checado_em: Date | null;
}

interface Mercado {
  ativo: string;
  aberto: boolean;
  payout_1m: string | null;
  payout_5m: string | null;
  velas: unknown;
  atualizado_em: Date;
}

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

/** Última vela fechada que cada estratégia já leu (uma leitura por vela). */
const lidas = new Map<number, number>();

export async function rodadaBinarias(agora = Date.now()): Promise<void> {
  await expirarApostas();
  const ativas = await query<Binaria & { ativo_mercado: Mercado | null }>(
    `select b.*, to_jsonb(m) as ativo_mercado
       from binarias b join contas c on c.id = b.conta_id
       left join quotex_mercado m on m.ativo = b.ativo
      where b.ativa and c.exchange = $1`,
    [QUOTEX],
  );
  for (const b of ativas) {
    try {
      const velas = velasQuotex(b.ativo_mercado?.velas, agora);
      const ultima = velas[velas.length - 1];
      if (!ultima) {
        await anotar(b.id, 'esperando a ponte mandar as velas deste ativo');
        continue;
      }
      if (lidas.get(b.id) === ultima.t) continue;
      lidas.set(b.id, ultima.t);
      const leitura = lerSinal(velas, b.estilo);
      if (!leitura.direcao) {
        await anotar(b.id, leitura.motivo);
        continue;
      }
      await pedirAposta(b.id, leitura.direcao, leitura.motivo);
    } catch (erro) {
      logger.error({ binaria: b.id, err: (erro as Error).message }, 'binárias: erro na estratégia');
    }
  }
}

async function anotar(id: number, situacao: string, c?: pg.PoolClient) {
  const sql = 'update binarias set situacao = $2, checado_em = now() where id = $1';
  if (c) await c.query(sql, [id, situacao]);
  else await query(sql, [id, situacao]);
}

export type Pedido = { ok: true; aposta: number; decisao: DecisaoAposta } | { ok: false; decisao: DecisaoAposta } | { ok: false; erro: string };

/** Pede uma aposta: confere tudo dentro da trava da estratégia e deixa a aposta pendente para a ponte. */
export async function pedirAposta(binariaId: number, direcao: Direcao, motivo: string): Promise<Pedido> {
  return transacao(async (c) => {
    // espaço de trava 3 (1 = estratégias do motor): um pedido por vez por estratégia de binárias
    await c.query('select pg_advisory_xact_lock(3, $1::int)', [binariaId]);
    const b = (await c.query<Binaria>('select * from binarias where id = $1', [binariaId])).rows[0];
    if (!b) return { ok: false, erro: 'estratégia não existe' } as const;
    const conta = (
      await c.query<{ modo: 'simulacao' | 'real'; ponte_visto_em: Date | null; ponte_info: Record<string, unknown> | null }>(
        'select modo, ponte_visto_em, ponte_info from contas where id = $1 and exchange = $2',
        [b.conta_id, QUOTEX],
      )
    ).rows[0];
    if (!conta) return { ok: false, erro: 'a conta da estratégia não é da Quotex' } as const;
    const mercado = (await c.query<Mercado>('select * from quotex_mercado where ativo = $1', [b.ativo])).rows[0];
    const parada = (await c.query<{ valor: boolean }>(`select valor from configuracoes where chave = 'parada_geral'`)).rows[0];
    const hoje = (
      await c.query<{ apostas: number; lucro: string; em_andamento: number; ultima: Date | null }>(
        `select count(*) filter (where situacao not in ('erro', 'expirada'))::int as apostas,
                coalesce(sum(lucro), 0) as lucro,
                count(*) filter (where situacao in ('pendente', 'enviada', 'aberta'))::int as em_andamento,
                max(criada_em) filter (where situacao not in ('erro', 'expirada')) as ultima
           from apostas where binaria_id = $1 and criada_em >= (date_trunc('day', now() at time zone $2) at time zone $2)`,
        [b.id, config.fuso],
      )
    ).rows[0]!;
    const resultados = (
      await c.query<{ situacao: 'ganhou' | 'perdeu' | 'empate' }>(
        `select situacao from apostas where binaria_id = $1 and situacao in ('ganhou', 'perdeu', 'empate')
            and criada_em >= (date_trunc('day', now() at time zone $2) at time zone $2) order by criada_em desc limit 50`,
        [b.id, config.fuso],
      )
    ).rows.map((r) => r.situacao);

    const info = conta.ponte_info ?? {};
    const ponteConta = info.conta === 'demo' || info.conta === 'real' ? info.conta : null;
    const saldo = typeof info.saldo === 'number' ? info.saldo : null;
    const decisao = avaliarAposta({
      paradaGeral: parada?.valor === true,
      realNoServidor: config.realLiberadoNoServidor,
      conta: { modo: conta.modo },
      binaria: {
        ativa: b.ativa,
        real: b.real,
        valor: Number(b.valor),
        payout_min: Number(b.payout_min),
        max_apostas_dia: b.max_apostas_dia,
        perda_max_dia: Number(b.perda_max_dia),
        perdas_seguidas_max: b.perdas_seguidas_max,
        intervalo_min_seg: b.intervalo_min_seg,
      },
      ponteOnline: conta.ponte_visto_em !== null && Date.now() - new Date(conta.ponte_visto_em).getTime() < PONTE_ONLINE_MS,
      ponteConta,
      ativo: mercado
        ? { aberto: mercado.aberto && Date.now() - new Date(mercado.atualizado_em).getTime() < 5 * 60_000, payout: num(payoutDoPrazo(b.prazo_s, num(mercado.payout_1m), num(mercado.payout_5m))) }
        : null,
      saldo,
      apostasHoje: hoje.apostas,
      perdaHoje: Math.max(0, -Number(hoje.lucro)),
      perdasSeguidas: perdasSeguidas(resultados),
      emAndamento: hoje.em_andamento > 0,
      ultimaApostaEm: hoje.ultima,
      agora: new Date(),
    });
    const lado = direcao === 'call' ? 'CALL (acima)' : 'PUT (abaixo)';
    if (!decisao.aprovado) {
      await anotar(b.id, `${lado}, mas não apostou: ${decisao.motivo}`, c);
      return { ok: false, decisao } as const;
    }
    const r = await c.query<{ id: number }>(
      `insert into apostas (binaria_id, conta_id, modo, ativo, direcao, valor, prazo_s, payout, motivo)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [b.id, b.conta_id, decisao.modo, b.ativo, direcao, decisao.valor, b.prazo_s, decisao.payout, motivo],
    );
    await anotar(b.id, `aposta pedida: ${lado} de ${decisao.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} em ${b.prazo_s / 60} min (${decisao.modo === 'real' ? 'REAL' : 'demo'}): ${motivo}`, c);
    logger.info({ binaria: b.id, aposta: r.rows[0]!.id, ativo: b.ativo, direcao, valor: decisao.valor, modo: decisao.modo }, 'aposta pedida à ponte Quotex');
    return { ok: true, aposta: r.rows[0]!.id, decisao } as const;
  });
}

/** Pendente que a ponte não pegou expira; enviada sem resposta vira erro; aberta sem resultado também. */
export async function expirarApostas(): Promise<void> {
  await query(
    `update apostas set situacao = 'expirada', terminada_em = now(), erro = 'a ponte não pegou a aposta a tempo'
      where situacao = 'pendente' and criada_em < now() - make_interval(secs => $1)`,
    [APOSTA_EXPIRA_S],
  );
  await query(
    `update apostas set situacao = 'erro', terminada_em = now(), erro = 'a ponte pegou a aposta e não respondeu: confira na Quotex'
      where situacao = 'enviada' and enviada_em < now() - interval '90 seconds'`,
  );
  await query(
    `update apostas set situacao = 'erro', terminada_em = now(), erro = 'sem resultado da ponte: confira no histórico da Quotex'
      where situacao = 'aberta' and aberta_em < now() - make_interval(secs => prazo_s + 300)`,
  );
}

// ------------------------------------------------------------------ sincronização com a ponte

export interface DadosPonte {
  versao?: string | undefined;
  conta?: { conta: 'demo' | 'real'; saldo?: number | undefined; moeda?: string | undefined } | undefined;
  mercado?: { ativo: string; nome?: string | undefined; aberto: boolean; payout_1m?: number | null | undefined; payout_5m?: number | null | undefined; velas?: number[][] | undefined }[] | undefined;
  abertas?: { id: number; ok: boolean; id_quotex?: string | undefined; erro?: string | undefined }[] | undefined;
  fechadas?: { id: number; resultado: 'ganhou' | 'perdeu' | 'empate'; retorno?: number | undefined }[] | undefined;
}

export interface ComandoPonte {
  id: number;
  ativo: string;
  direcao: Direcao;
  valor: number;
  prazo_s: number;
  conta: 'demo' | 'real';
  idade_s: number;
}

export async function sincronizarPonte(contaId: number, d: DadosPonte): Promise<{ observar: string[]; comandos: ComandoPonte[] }> {
  await query(`update contas set ponte_visto_em = now(), ponte_info = coalesce($2::jsonb, ponte_info) where id = $1`, [
    contaId,
    d.conta ? JSON.stringify({ ...d.conta, versao: d.versao ?? null }) : null,
  ]);

  for (const m of d.mercado ?? []) {
    // sem velas = só a lista de ativos e payouts: as velas que já estavam ficam
    await query(
      `insert into quotex_mercado (ativo, nome, aberto, payout_1m, payout_5m, velas, atualizado_em) values ($1, $2, $3, $4, $5, coalesce($6::jsonb, '[]'), now())
       on conflict (ativo) do update set nome = coalesce($2, quotex_mercado.nome), aberto = $3, payout_1m = $4, payout_5m = $5,
         velas = coalesce($6::jsonb, quotex_mercado.velas), atualizado_em = now()`,
      [m.ativo, m.nome ?? null, m.aberto, m.payout_1m ?? null, m.payout_5m ?? null, m.velas ? JSON.stringify(m.velas) : null],
    );
  }

  for (const a of d.abertas ?? []) {
    if (a.ok) {
      // a Quotex aceitou: o log é a prova da aposta, antes de qualquer gravação
      logger.info({ aposta: a.id, conta: contaId, id_quotex: a.id_quotex ?? null }, 'aposta aberta na Quotex');
      await query(
        `update apostas set situacao = 'aberta', id_quotex = $3, aberta_em = now() where id = $1 and conta_id = $2 and situacao = 'enviada'`,
        [a.id, contaId, a.id_quotex ?? null],
      );
    } else {
      await query(
        `update apostas set situacao = 'erro', erro = $3, terminada_em = now() where id = $1 and conta_id = $2 and situacao = 'enviada'`,
        [a.id, contaId, (a.erro ?? 'erro sem detalhe').slice(0, 500)],
      );
    }
  }

  for (const f of d.fechadas ?? []) {
    // "erro" também aceita: a aposta pode ter passado do tempo aqui e o resultado chegar depois
    const r = await query<{ valor: string; payout: string }>(
      `select valor, payout from apostas where id = $1 and conta_id = $2 and situacao in ('aberta', 'erro') and id_quotex is not null`,
      [f.id, contaId],
    );
    if (!r[0]) {
      logger.warn({ aposta: f.id, conta: contaId }, 'ponte Quotex mandou o resultado de uma aposta que não estava aberta');
      continue;
    }
    const lucro = lucroDaAposta(f.resultado, Number(r[0].valor), Number(r[0].payout));
    logger.info({ aposta: f.id, conta: contaId, resultado: f.resultado, lucro }, 'aposta encerrada na Quotex');
    await query(
      `update apostas set situacao = $3, lucro = $4, retorno = $5, erro = null, terminada_em = now() where id = $1 and conta_id = $2`,
      [f.id, contaId, f.resultado, lucro, f.retorno ?? null],
    );
  }

  const comandos = await transacao(async (c) => {
    await c.query(
      `update apostas set situacao = 'expirada', terminada_em = now(), erro = 'a ponte não pegou a aposta a tempo'
        where conta_id = $1 and situacao = 'pendente' and criada_em < now() - make_interval(secs => $2)`,
      [contaId, APOSTA_EXPIRA_S],
    );
    const r = await c.query<{ id: number; ativo: string; direcao: Direcao; valor: string; prazo_s: number; modo: 'simulacao' | 'real'; idade_s: number }>(
      `update apostas set situacao = 'enviada', enviada_em = now()
        where id in (select id from apostas where conta_id = $1 and situacao = 'pendente' order by id for update skip locked)
        returning id, ativo, direcao, valor, prazo_s, modo, extract(epoch from now() - criada_em)::float as idade_s`,
      [contaId],
    );
    return r.rows;
  });
  for (const c of comandos) logger.info({ aposta: c.id, conta: contaId, ativo: c.ativo, direcao: c.direcao }, 'aposta entregue à ponte Quotex');

  const observar = await query<{ ativo: string }>(
    `select distinct ativo from binarias where conta_id = $1 order by 1 limit 20`,
    [contaId],
  );
  return {
    observar: observar.map((o) => o.ativo),
    comandos: comandos.map((c) => ({
      id: c.id,
      ativo: c.ativo,
      direcao: c.direcao,
      valor: Number(c.valor),
      prazo_s: c.prazo_s,
      conta: c.modo === 'real' ? 'real' : 'demo',
      idade_s: c.idade_s,
    })),
  };
}

export function iniciarBinarias(): () => void {
  let rodando = false;
  const passo = async () => {
    if (rodando) return;
    rodando = true;
    try {
      await rodadaBinarias();
    } catch (erro) {
      logger.error({ err: (erro as Error).message }, 'binárias: erro na passada');
    } finally {
      rodando = false;
    }
  };
  const timer = setInterval(passo, INTERVALO_MS);
  timer.unref();
  return () => clearInterval(timer);
}
