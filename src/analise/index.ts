import { query } from '../db.js';
import { logger } from '../logger.js';
import { velasDiarias } from '../brokers/ccxt.js';
import { chamarIa, mensagemDeErro, type ConectorIa } from '../ia/index.js';
import { AGENTES, ESQUEMA_AGENTE, sistemaDoAgente, type Agente } from './agentes.js';
import { resumoTecnico } from './indicadores.js';
import { kronosLigado, preverKronos, resumoParaIa } from '../previsao/kronos.js';
import { conceito, lerAgente, notaComposta, type ResultadoAgente } from './nota.js';

// Análise completa: busca as velas na exchange, calcula os indicadores e manda os 5 agentes ao
// mesmo tempo. Roda em segundo plano; o painel acompanha pela linha em `analises`, que é
// atualizada a cada agente que termina. Não executa nada: só gera a nota.

const TEMPO_AGENTE_SEG = 150;

export interface PedidoAnalise {
  simbolo: string;
  exchange: string | null;
  conectores: ConectorIa[];
  pesquisaWeb: boolean;
  usuarioId: number | undefined;
}

/**
 * Indicadores das velas diárias da exchange (null sem exchange) e, se o Kronos estiver no ar, a
 * previsão dele para os próximos 5 dias. Lança se a exchange falhar; o Kronos falhando só vira aviso.
 */
export async function dadosDeMercado(exchange: string | null, simbolo: string, opcoes: { previsao?: boolean } = {}) {
  if (!exchange) return null;
  const velas = await velasDiarias(exchange, simbolo);
  if (velas.length < 30) throw new Error(`a ${exchange} devolveu só ${velas.length} velas de ${simbolo}`);
  // força relativa contra o BTC na mesma moeda de cotação, quando o par não é o próprio BTC
  let referencia: number[] | undefined;
  const [base, cotacao] = simbolo.split('/');
  if (base !== 'BTC' && cotacao) {
    referencia = await velasDiarias(exchange, `BTC/${cotacao.split(':')[0]}`)
      .then((v) => v.map((c) => c.fecha))
      .catch(() => undefined);
  }
  const dados: Record<string, unknown> = { exchange, simbolo, ...resumoTecnico(velas, referencia) };
  if (opcoes.previsao !== false && kronosLigado()) {
    try {
      const p = await preverKronos(velas);
      const r = (v: number) => Number(v.toPrecision(6));
      dados.previsao_kronos = { ...resumoParaIa(p), datas: p.datas, mediana: p.mediana.map(r), p10: p.p10.map(r), p90: p.p90.map(r), ms: p.ms };
    } catch (e) {
      dados.previsao_kronos = { erro: (e as Error).message.slice(0, 200) };
    }
  }
  return dados;
}

function textoDoAgente(a: Agente, simbolo: string, dados: unknown, motivoSemDados: string | null): string {
  return [
    `Ativo: ${simbolo}. Data de hoje: ${new Date().toISOString().slice(0, 10)}.`,
    dados ? `<dados>\n${JSON.stringify(dados, null, 2)}\n</dados>` : `Sem dados de mercado da exchange (${motivoSemDados ?? 'não informada'}).`,
    `Faça a análise ${a.nome.toLowerCase()} e responda só com o JSON.`,
  ].join('\n\n');
}

async function gravarAgente(id: number, agente: string, valor: object): Promise<void> {
  await query(`update analises set agentes = jsonb_set(agentes, $2, $3::jsonb) where id = $1`, [id, `{${agente}}`, JSON.stringify(valor)]);
}

/** Cria a análise e devolve o id na hora; os agentes continuam rodando. */
export async function iniciarAnalise(p: PedidoAnalise): Promise<number> {
  const inicial = Object.fromEntries(
    AGENTES.map((a, i) => {
      const c = p.conectores[i % p.conectores.length]!;
      return [a.id, { situacao: 'rodando', conector: c.nome, modelo: c.modelo }];
    }),
  );
  const [linha] = await query<{ id: number }>(
    `insert into analises (simbolo, exchange, agentes, pesquisa_web, usuario_id) values ($1, $2, $3, $4, $5) returning id`,
    [p.simbolo, p.exchange, JSON.stringify(inicial), p.pesquisaWeb, p.usuarioId ?? null],
  );
  const id = linha!.id;
  rodar(id, p).catch((e) => logger.error({ analise: id, err: (e as Error).message }, 'análise falhou'));
  return id;
}

async function rodar(id: number, p: PedidoAnalise): Promise<void> {
  let dados = null;
  let motivoSemDados: string | null = null;
  try {
    dados = await dadosDeMercado(p.exchange, p.simbolo);
  } catch (e) {
    motivoSemDados = (e as Error).message.slice(0, 200);
  }
  await query('update analises set dados = $2 where id = $1', [id, JSON.stringify(dados ?? { erro: motivoSemDados })]);

  const resultados = await Promise.all(
    AGENTES.map(async (a, i) => {
      const c = p.conectores[i % p.conectores.length]!;
      const inicio = Date.now();
      // pesquisa na web só existe no Claude
      const web = p.pesquisaWeb && c.provedor === 'anthropic';
      try {
        const texto = await chamarIa(c, sistemaDoAgente(a, web), textoDoAgente(a, p.simbolo, dados, motivoSemDados), {
          esquema: ESQUEMA_AGENTE,
          pesquisaWeb: web,
          timeoutSeg: Math.max(c.timeout_seg, TEMPO_AGENTE_SEG),
        });
        const resultado = lerAgente(texto, a);
        await gravarAgente(id, a.id, { situacao: 'pronto', conector: c.nome, modelo: c.modelo, ms: Date.now() - inicio, web, resultado });
        return { a, resultado };
      } catch (e) {
        const erro = mensagemDeErro(c, e);
        await gravarAgente(id, a.id, { situacao: 'falhou', conector: c.nome, modelo: c.modelo, ms: Date.now() - inicio, erro });
        return { a, resultado: null as ResultadoAgente | null };
      }
    }),
  );

  const nota = notaComposta(resultados.map((r) => ({ peso: r.a.peso, nota: r.resultado?.nota ?? null })));
  if (nota === null) {
    await query(`update analises set situacao = 'falhou', terminada_em = now() where id = $1`, [id]);
    return;
  }
  const c = conceito(nota);
  await query(`update analises set situacao = 'pronta', nota = $2, conceito = $3, sinal = $4, terminada_em = now() where id = $1`, [id, nota, c.conceito, c.sinal]);
  logger.info({ analise: id, simbolo: p.simbolo, nota }, 'análise pronta');
}

/** Análise que sobrou "rodando" de uma subida anterior do servidor fica marcada como falha. */
export async function fecharAnalisesInterrompidas(): Promise<void> {
  await query(`update analises set situacao = 'falhou', terminada_em = now() where situacao = 'rodando'`);
}
