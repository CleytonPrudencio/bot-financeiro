import type pg from 'pg';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { dadosDeMercado } from '../analise/index.js';
import { chamarIa, mensagemDeErro, type ConectorIa, type PedidoParecer, type RespostaIa } from '../ia/index.js';
import { ESQUEMA_PARECER, lerParecer } from '../ia/prompt.js';
import { ESQUEMA_ETAPA, ETAPAS, ETAPAS_DE_APOIO, etapaDaPrevisao, lerEtapa, relatorios, sistemaDaEtapa, SISTEMA_DECISAO, type IdEtapa, type ResultadoEtapa } from './etapas.js';

// Agente em etapas: pesquisa, sentimento, técnica e risco rodam ao mesmo tempo, cada uma na IA
// escolhida para ela; depois a IA da decisão lê os relatórios e aprova ou veta. O resultado entra
// no motor como UM voto (decidirComIa), então vale a mesma regra: só barra.

export interface ConfigAgente {
  /** conector_id nas etapas de IA; `ligada` na previsão do Kronos */
  etapas: Partial<Record<IdEtapa, { conector_id?: number | null; web?: boolean; ligada?: boolean }>>;
}

/** A previsão do Kronos entra na esteira? */
export const previsaoLigada = (config: ConfigAgente) => Boolean(config.etapas.previsao?.ligada);

export type SaidaEtapa =
  | { ok: true; conector: string; modelo: string; ms: number; web: boolean; resultado: ResultadoEtapa }
  | { ok: false; conector: string; modelo: string; ms: number; erro: string };

export interface ResultadoAgente {
  etapas: Partial<Record<IdEtapa, SaidaEtapa>>;
  final: RespostaIa;
  ms: number;
}

type Consulta = <T extends pg.QueryResultRow>(sql: string, p?: unknown[]) => Promise<T[]>;
const consultaPadrao: Consulta = (sql, p) => query(sql, p);

export async function lerConfig(q: Consulta = consultaPadrao): Promise<ConfigAgente> {
  const [linha] = await q<{ valor: ConfigAgente }>(`select valor from configuracoes where chave = 'agente'`);
  return { etapas: linha?.valor?.etapas ?? {} };
}

export async function salvarConfig(config: ConfigAgente): Promise<void> {
  await query(
    `insert into configuracoes (chave, valor) values ('agente', $1) on conflict (chave) do update set valor = $1, alterado_em = now()`,
    [JSON.stringify(config)],
  );
}

/** O agente está pronto se a etapa de decisão tem uma IA ativa. */
export function agentePronto(config: ConfigAgente, conectores: ConectorIa[]): boolean {
  const id = config.etapas.decisao?.conector_id;
  return Boolean(id && conectores.some((c) => c.id === id && c.ativo));
}

function textoDaOrdem(pedido: PedidoParecer, dados: unknown): string {
  return [
    `<ordem>\n${JSON.stringify(pedido, null, 2)}\n</ordem>`,
    dados ? `<dados>\n${JSON.stringify(dados, null, 2)}\n</dados>` : 'Sem dados de mercado calculados (a exchange não respondeu ou o ativo não tem velas).',
  ].join('\n\n');
}

export interface OpcoesRodar {
  pedido: PedidoParecer;
  dados: unknown;
  config: ConfigAgente;
  conectores: ConectorIa[];
  /** chamado a cada etapa que termina (o painel acompanha o teste ao vivo) */
  aoAtualizar?: (etapa: IdEtapa, saida: SaidaEtapa) => Promise<void> | void;
}

export async function rodarAgente({ pedido, dados, config, conectores, aoAtualizar }: OpcoesRodar): Promise<ResultadoAgente> {
  const inicio = Date.now();
  const conectorDa = (e: IdEtapa) => {
    const id = config.etapas[e]?.conector_id;
    return conectores.find((c) => c.id === id && c.ativo) ?? null;
  };
  const texto = textoDaOrdem(pedido, dados);

  const etapas: ResultadoAgente['etapas'] = {};
  await Promise.all(
    ETAPAS_DE_APOIO.map(async (e) => {
      if (e.kronos) {
        if (!previsaoLigada(config)) return;
        const p = (dados as { previsao_kronos?: { erro?: string; modelo?: string; ms?: number } } | null)?.previsao_kronos;
        const saida: SaidaEtapa = !p
          ? { ok: false, conector: 'Kronos', modelo: '-', ms: 0, erro: 'sem previsão (Kronos fora do ar ou ativo sem velas)' }
          : p.erro
            ? { ok: false, conector: 'Kronos', modelo: '-', ms: 0, erro: p.erro }
            : { ok: true, conector: 'Kronos', modelo: p.modelo ?? 'Kronos', ms: p.ms ?? 0, web: false, resultado: etapaDaPrevisao(p as Parameters<typeof etapaDaPrevisao>[0], pedido.lado) };
        etapas[e.id] = saida;
        await aoAtualizar?.(e.id, saida);
        return;
      }
      const c = conectorDa(e.id);
      if (!c) return;
      const web = Boolean(e.usaWeb && config.etapas[e.id]?.web && c.provedor === 'anthropic');
      const t0 = Date.now();
      let saida: SaidaEtapa;
      try {
        const resposta = await chamarIa(c, sistemaDaEtapa(e, web || /perplexity/.test(c.url_base ?? '')), texto, {
          esquema: ESQUEMA_ETAPA,
          pesquisaWeb: web,
          timeoutSeg: web ? Math.max(c.timeout_seg, 60) : c.timeout_seg,
        });
        saida = { ok: true, conector: c.nome, modelo: c.modelo, ms: Date.now() - t0, web, resultado: lerEtapa(resposta) };
      } catch (erro) {
        saida = { ok: false, conector: c.nome, modelo: c.modelo, ms: Date.now() - t0, erro: mensagemDeErro(c, erro) };
      }
      etapas[e.id] = saida;
      await aoAtualizar?.(e.id, saida);
    }),
  );

  const juiz = conectorDa('decisao');
  let final: RespostaIa;
  if (!juiz) {
    final = { conector_id: 0, conector: 'agente', modelo: '-', ok: false, erro: 'a etapa de decisão está sem IA', ms: 0 };
  } else {
    const t0 = Date.now();
    const base = { conector_id: juiz.id, conector: `agente · ${juiz.nome}`, modelo: juiz.modelo };
    try {
      const sistema = juiz.instrucoes ? `${SISTEMA_DECISAO}\n\nOrientação do dono: ${juiz.instrucoes}` : SISTEMA_DECISAO;
      const resposta = await chamarIa(juiz, sistema, `${texto}\n\n<relatorios>\n${relatorios(etapas)}\n</relatorios>`, { esquema: ESQUEMA_PARECER });
      final = { ...base, ok: true, parecer: lerParecer(resposta), ms: Date.now() - t0 };
    } catch (erro) {
      final = { ...base, ok: false, erro: mensagemDeErro(juiz, erro), ms: Date.now() - t0 };
    }
  }
  logger.info({ simbolo: pedido.simbolo, final: final.ok ? final.parecer.decisao : 'falhou', ms: Date.now() - inicio }, 'agente em etapas');
  return { etapas, final, ms: Date.now() - inicio };
}

/** Dados de mercado para o agente (com a previsão do Kronos, se a etapa estiver ligada); sem exchange ou com erro, segue sem eles. */
export async function dadosParaAgente(exchange: string | null, simbolo: string, previsao = false): Promise<unknown> {
  if (!exchange || !simbolo.includes('/')) return null;
  try {
    return await dadosDeMercado(exchange, simbolo, { previsao });
  } catch (e) {
    return { erro: (e as Error).message.slice(0, 200) };
  }
}

export async function gravarExecucao(
  q: Consulta,
  dados: { sinalId: number | null; estrategiaId: number | null; origem: 'sinal' | 'teste'; simbolo: string; lado: 'compra' | 'venda' },
  r: ResultadoAgente,
): Promise<void> {
  await q(
    `insert into agente_execucoes (sinal_id, estrategia_id, origem, simbolo, lado, situacao, etapas, decisao, confianca, motivo, ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [dados.sinalId, dados.estrategiaId, dados.origem, dados.simbolo, dados.lado, r.final.ok ? 'pronta' : 'falhou', JSON.stringify(r.etapas),
      r.final.ok ? r.final.parecer.decisao : null, r.final.ok ? r.final.parecer.confianca : null, r.final.ok ? r.final.parecer.motivo : r.final.erro, r.ms],
  );
}

/** Teste pelo painel: cria a linha, roda em segundo plano e vai gravando cada etapa. */
export async function iniciarTeste(pedido: PedidoParecer, exchange: string | null, conectores: ConectorIa[]): Promise<number> {
  const config = await lerConfig();
  const inicial = Object.fromEntries(
    ETAPAS.flatMap((e) => {
      if (e.kronos) return previsaoLigada(config) ? [[e.id, { situacao: 'rodando', conector: 'Kronos', modelo: '' }]] : [];
      const c = conectores.find((x) => x.id === config.etapas[e.id]?.conector_id && x.ativo);
      return c ? [[e.id, { situacao: 'rodando', conector: c.nome, modelo: c.modelo }]] : [];
    }),
  );
  const [linha] = await query<{ id: number }>(
    `insert into agente_execucoes (origem, simbolo, lado, etapas) values ('teste', $1, $2, $3) returning id`,
    [pedido.simbolo, pedido.lado, JSON.stringify(inicial)],
  );
  const id = linha!.id;
  (async () => {
    const dados = await dadosParaAgente(exchange, pedido.simbolo, previsaoLigada(config));
    const r = await rodarAgente({
      pedido,
      dados,
      config,
      conectores,
      aoAtualizar: (etapa, saida) =>
        query('update agente_execucoes set etapas = jsonb_set(etapas, $2, $3::jsonb) where id = $1', [id, `{${etapa}}`, JSON.stringify({ situacao: saida.ok ? 'pronto' : 'falhou', ...saida })]).then(() => undefined),
    });
    await query(
      `update agente_execucoes set situacao = $2, decisao = $3, confianca = $4, motivo = $5, ms = $6,
              etapas = jsonb_set(etapas, '{decisao}', $7::jsonb) where id = $1`,
      [id, r.final.ok ? 'pronta' : 'falhou', r.final.ok ? r.final.parecer.decisao : null, r.final.ok ? r.final.parecer.confianca : null,
        r.final.ok ? r.final.parecer.motivo : r.final.erro, r.ms,
        JSON.stringify({ situacao: r.final.ok ? 'pronto' : 'falhou', conector: r.final.conector, modelo: r.final.modelo, ms: r.final.ms, ...(r.final.ok ? { parecer: r.final.parecer } : { erro: r.final.erro }) })],
    );
  })().catch(async (e) => {
    logger.error({ execucao: id, err: (e as Error).message }, 'teste do agente falhou');
    await query(`update agente_execucoes set situacao = 'falhou', motivo = 'erro interno' where id = $1`, [id]).catch(() => undefined);
  });
  return id;
}

export async function fecharTestesInterrompidos(): Promise<void> {
  await query(`update agente_execucoes set situacao = 'falhou', motivo = 'o servidor reiniciou no meio' where situacao = 'rodando'`);
}
