import { config } from '../config.js';
import { novoToken } from '../crypto.js';
import { query, transacao, umOuNada } from '../db.js';
import { logger } from '../logger.js';
import { cotacaoPublica, MS_DA_VELA, paresDaMoeda, velas } from '../brokers/ccxt.js';
import type { Vela } from '../analise/indicadores.js';
import { moedas } from '../brokers/tipos.js';
import { corretoraReal, processarSinalDa, type Conta, type Estrategia, type Resultado } from '../motor.js';
import { kronosLigado, preverKronos } from '../previsao/kronos.js';
import { conferirSaida } from '../risco.js';
import { avaliarEntrada, DIA_MS, filtroDiario, KRONOS_MIN_ALTA, tendenciaQuebrou, velasFechadas } from './regras.js';

// Piloto automático: o bot gera os próprios sinais das estratégias com "piloto ligado" e manda pelo
// mesmo caminho do webhook (processarSinalDa). Então vale tudo: regras de risco, trava por
// estratégia, agente de IA nas compras e as três chaves do dinheiro real. O piloto não cria
// atalho nenhum: ele só decide QUANDO pedir.
//
// - a cada minuto: cotação de cada estratégia com posição aberta → stop, alvo ou proteção do ganho;
//   uma vez por dia, a saída por tendência (fechamento diário abaixo da média de 50);
// - sem posição, a cada `auto_intervalo_min`: olha o par da estratégia ou, com `auto_varrer`, todos
//   os pares da moeda da conta com volume (ex.: tudo em BRL na Binance), em velas fechadas de
//   `auto_tempo`; o par que virou para alta e tem a maior chance no Kronos vai para o agente. Um par
//   de cada vez (a estratégia troca de par só sem posição) e um teto de consultas à IA por dia.

const INTERVALO_MS = 60_000;
/** Sinal do piloto aparece com este "IP" no histórico. */
export const ORIGEM = 'piloto';

interface EstrategiaPiloto extends Estrategia {
  exchange: string;
  conta_modo: 'simulacao' | 'real';
  quantidade: number;
  custo_total: number;
  maior_preco: number | null;
}

const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const textoResultado = (r: Resultado) => (r.status === 404 ? 'estratégia sumiu' : `${r.situacao}${r.motivo ? `: ${r.motivo}` : ''}`);

async function situacao(id: number, texto: string): Promise<void> {
  await query(`update estrategias set auto_situacao = $2, auto_checado_em = now() where id = $1`, [id, texto.slice(0, 500)]);
}

/** O que o piloto viu em cada par: o escritório ao vivo mostra um robô por par. */
interface Olhado {
  simbolo: string;
  preco: number | null;
  variacao_pct: number | null;
  volume: number | null;
  motivo: string;
  virou: boolean;
}
async function gravarVarredura(id: number, olhados: Olhado[]): Promise<void> {
  await query('update estrategias set auto_varredura = $2 where id = $1', [id, JSON.stringify(olhados)]);
}

/** Quanto comprar: o valor da estratégia, ou o saldo livre (menos 1%) se for menor. Nunca mais que o valor. */
async function valorDaCompra(e: EstrategiaPiloto): Promise<number | null> {
  const moeda = moedas(e.simbolo).cotacao;
  const real = e.real && e.conta_modo === 'real' && config.realLiberadoNoServidor;
  let livre: number;
  if (real) {
    const conta = (await umOuNada<Conta>('select * from contas where id = $1', [e.conta_id]))!;
    livre = (await corretoraReal(conta).saldos())[moeda] ?? 0;
  } else {
    const [s] = await query<{ quantidade: number }>('select quantidade from saldos_simulados where conta_id = $1 and moeda = $2', [e.conta_id, moeda]);
    livre = s?.quantidade ?? 0;
  }
  if (livre >= e.valor_ordem) return e.valor_ordem;
  const valor = Math.floor(livre * 0.99 * 100) / 100;
  return valor > 0 ? valor : null;
}

/** Já olhou este par nesta vela (o Kronos não roda duas vezes na mesma vela). Chave → expira em. */
const avaliados = new Map<string, number>();
/** Última vela diária em que a saída por tendência foi conferida, por estratégia. */
const tendenciaConferida = new Map<number, number>();
/** Depois que a IA ou as regras barraram a compra num par, ele descansa este tempo. */
const ESPERA_DEPOIS_DE_VETO_MS = 6 * 3_600_000;
const MAX_PARES = 25;

const diariasCache = new Map<string, { ate: number; velas: Promise<Vela[]> }>();
function diariasComCache(exchange: string, simbolo: string): Promise<Vela[]> {
  const chave = `${exchange}|${simbolo}`;
  const atual = diariasCache.get(chave);
  if (atual && atual.ate > Date.now()) return atual.velas;
  const v = velas(exchange, simbolo, '1d', 120);
  diariasCache.set(chave, { ate: Date.now() + 3_600_000, velas: v });
  v.catch(() => diariasCache.delete(chave));
  return v;
}

/** Quantas compras do piloto passaram pela IA hoje (fuso de São Paulo): é o que custa. */
async function consultasDeHoje(estrategiaId: number): Promise<number> {
  const [r] = await query<{ n: number }>(
    `select count(*)::int as n from sinais s
      where s.estrategia_id = $1 and s.corpo->>'id' like 'piloto-entrada-%'
        and s.recebido_em >= (date_trunc('day', now() at time zone $2) at time zone $2)
        and (exists (select 1 from agente_execucoes a where a.sinal_id = s.id)
             or exists (select 1 from pareceres_ia p where p.sinal_id = s.id))`,
    [estrategiaId, config.fuso],
  );
  return r?.n ?? 0;
}

/** Pares em que a compra foi barrada há pouco: ficam de fora por um tempo. */
async function paresBarrados(estrategiaId: number): Promise<Set<string>> {
  const linhas = await query<{ simbolo: string }>(
    `select distinct corpo->>'simbolo' as simbolo from sinais
      where estrategia_id = $1 and corpo->>'id' like 'piloto-entrada-%' and situacao = 'rejeitado'
        and recebido_em > now() - make_interval(secs => $2)`,
    [estrategiaId, ESPERA_DEPOIS_DE_VETO_MS / 1000],
  );
  return new Set(linhas.map((l) => l.simbolo).filter(Boolean));
}

/** Troca o par da estratégia para o escolhido, só sem posição aberta (dentro da trava da estratégia). */
async function trocarPar(estrategiaId: number, simbolo: string): Promise<boolean> {
  return transacao(async (c) => {
    await c.query('select pg_advisory_xact_lock(1, $1::int)', [estrategiaId]);
    const pos = await c.query<{ quantidade: number }>('select quantidade from posicoes where estrategia_id = $1', [estrategiaId]);
    if ((pos.rows[0]?.quantidade ?? 0) > 0) return false;
    await c.query('update estrategias set simbolo = $2 where id = $1', [estrategiaId, simbolo]);
    return true;
  });
}

interface Candidato {
  simbolo: string;
  vela: number;
  motivo: string;
  prob: number | null;
}

async function cuidar(e: EstrategiaPiloto, agora: number): Promise<void> {
  if (e.quantidade > 0) return cuidarDaPosicao(e, agora);

  // sem posição: olha o mercado a cada auto_intervalo_min
  const varridoEm = e.auto_varrido_em ? new Date(e.auto_varrido_em).getTime() : 0;
  if (agora - varridoEm < e.auto_intervalo_min * 60_000 - 5_000) return;
  await query('update estrategias set auto_varrido_em = now(), auto_checado_em = now() where id = $1', [e.id]);

  const tempo = e.auto_tempo;
  const duracao = MS_DA_VELA[tempo];
  const moeda = moedas(e.simbolo).cotacao;
  const listados = e.auto_varrer
    ? (await paresDaMoeda(e.exchange, moeda, e.auto_volume_min)).slice(0, MAX_PARES)
    : [{ simbolo: e.simbolo, volume: null, preco: null, variacao_pct: null }];
  const pares = listados.map((p) => p.simbolo);
  if (!pares.length) return situacao(e.id, `nenhum par em ${moeda} na ${e.exchange} com volume de 24 h acima de ${e.auto_volume_min}`);

  const consultas = await consultasDeHoje(e.id);
  if (consultas >= e.auto_max_ia_dia) {
    return situacao(e.id, `já consultou a IA ${consultas} vez(es) hoje, o limite da estratégia: volta a procurar amanhã (o stop segue valendo)`);
  }

  const barrados = await paresBarrados(e.id);
  const resumo: string[] = [];
  const candidatos: Candidato[] = [];
  const olhados: Olhado[] = [];
  const anotar = (simbolo: string, motivo: string, virou = false, fechamento?: number) => {
    const l = listados.find((x) => x.simbolo === simbolo);
    olhados.push({ simbolo, preco: l?.preco ?? fechamento ?? null, variacao_pct: l?.variacao_pct ?? null, volume: l?.volume ?? null, motivo, virou });
    if (!virou) resumo.push(`${simbolo}: ${motivo}`);
  };
  for (const [k, v] of avaliados) if (v < agora) avaliados.delete(k);
  for (const simbolo of pares) {
    if (barrados.has(simbolo)) {
      anotar(simbolo, 'barrado há pouco, descansa');
      continue;
    }
    const fechadas = velasFechadas(await velas(e.exchange, simbolo, tempo, 260), agora, duracao);
    const vela = fechadas[fechadas.length - 1]?.t ?? 0;
    const fechamento = fechadas[fechadas.length - 1]?.fecha;
    const entrada = avaliarEntrada(fechadas);
    if (!entrada.comprar) {
      anotar(simbolo, entrada.motivo.replace(/^sem entrada: /, ''), false, fechamento);
      continue;
    }
    if (tempo !== '1d') {
      const contra = filtroDiario(velasFechadas(await diariasComCache(e.exchange, simbolo), agora));
      if (contra) {
        anotar(simbolo, `virou, mas ${contra}`, false, fechamento);
        continue;
      }
    }
    const chave = `${e.id}|${simbolo}|${vela}`;
    if (avaliados.has(chave)) {
      anotar(simbolo, 'virou nesta vela e já foi avaliado', false, fechamento);
      continue;
    }
    avaliados.set(chave, agora + 2 * duracao + 3_600_000);
    // corte pelo Kronos antes de gastar IA (fora do ar: segue, e o agente decide sem a previsão)
    let prob: number | null = null;
    if (kronosLigado()) {
      try {
        prob = (await preverKronos(fechadas)).prob_alta;
      } catch (erro) {
        logger.warn({ estrategia: e.id, simbolo, err: (erro as Error).message }, 'piloto: Kronos fora; segue sem a previsão');
      }
      if (prob !== null && prob < KRONOS_MIN_ALTA) {
        anotar(simbolo, `virou, mas o Kronos dá só ${Math.round(prob * 100)}% de chance de alta`, false, fechamento);
        continue;
      }
    }
    anotar(simbolo, `${entrada.motivo}${prob !== null ? `; Kronos ${Math.round(prob * 100)}% de alta` : ''}`, true, fechamento);
    candidatos.push({ simbolo, vela, motivo: entrada.motivo, prob });
  }
  await gravarVarredura(e.id, olhados);

  const olhou = `olhou ${pares.length} ${pares.length === 1 ? 'par' : 'pares'} em velas de ${tempo}`;
  if (!candidatos.length) return situacao(e.id, `${olhou}: nenhum virou para alta agora. ${resumo.slice(0, 6).join('; ')}`);

  // o melhor: maior chance de alta no Kronos; empate (ou sem Kronos), o mais negociado
  const melhor = [...candidatos].sort((a, b) => (b.prob ?? -1) - (a.prob ?? -1))[0]!;
  if (melhor.simbolo !== e.simbolo && !(await trocarPar(e.id, melhor.simbolo))) {
    return situacao(e.id, `${olhou}: ${melhor.simbolo} virou, mas apareceu posição aberta no meio do caminho`);
  }
  const preco = await cotacaoPublica(e.exchange, melhor.simbolo);
  const valor = await valorDaCompra({ ...e, simbolo: melhor.simbolo });
  const kronos = melhor.prob !== null ? `, Kronos ${Math.round(melhor.prob * 100)}% de alta` : '';
  if (valor === null) return situacao(e.id, `${melhor.simbolo}: ${melhor.motivo}${kronos}, mas não há saldo livre para comprar`);
  const r = await processarSinalDa(
    e.id,
    { acao: 'comprar', simbolo: melhor.simbolo, preco, valor, id: `piloto-entrada-${melhor.simbolo}-${melhor.vela}` },
    ORIGEM,
  );
  logger.info({ estrategia: e.id, simbolo: melhor.simbolo, resultado: textoResultado(r) }, 'piloto: entrada');
  return situacao(e.id, `${melhor.simbolo}: ${melhor.motivo}${kronos} → ${textoResultado(r)}`);
}

/** Com posição: a cada passada, stop, alvo e proteção; uma vez por vela diária, a saída por tendência. */
async function cuidarDaPosicao(e: EstrategiaPiloto, agora: number): Promise<void> {
  const preco = await cotacaoPublica(e.exchange, e.simbolo);
  const precoMedio = e.custo_total / e.quantidade;
  const [p] = await query<{ maior_preco: number }>(
    `update posicoes set maior_preco = greatest(coalesce(maior_preco, $2), $2) where estrategia_id = $1 returning maior_preco`,
    [e.id, preco],
  );
  const saida = conferirSaida(precoMedio, preco, p?.maior_preco ?? preco, {
    stopPct: e.auto_stop_pct, alvoPct: e.auto_alvo_pct, protecaoPct: e.auto_protecao_pct, recuoPct: e.auto_recuo_pct,
  });
  if (saida.sair) {
    const r = await processarSinalDa(e.id, { acao: 'zerar', preco, id: `piloto-${saida.tipo}-${agora}` }, ORIGEM);
    logger.info({ estrategia: e.id, tipo: saida.tipo, resultado: textoResultado(r) }, 'piloto: saída');
    return situacao(e.id, `${e.simbolo}: ${saida.motivo} → ${textoResultado(r)}`);
  }
  const texto = `${e.simbolo}: posição aberta, ${pct((preco / precoMedio - 1) * 100)} desde a compra; stop em ${(precoMedio * (1 - e.auto_stop_pct / 100)).toPrecision(6)}`;

  const ultimaDiaria = Math.floor(agora / DIA_MS) * DIA_MS - DIA_MS;
  if ((tendenciaConferida.get(e.id) ?? 0) < ultimaDiaria) {
    tendenciaConferida.set(e.id, ultimaDiaria);
    const quebra = tendenciaQuebrou(velasFechadas(await diariasComCache(e.exchange, e.simbolo), agora));
    if (quebra) {
      const r = await processarSinalDa(e.id, { acao: 'zerar', preco, id: `piloto-tendencia-${e.simbolo}-${ultimaDiaria}` }, ORIGEM);
      logger.info({ estrategia: e.id, resultado: textoResultado(r) }, 'piloto: saída por tendência');
      return situacao(e.id, `${e.simbolo}: ${quebra} → ${textoResultado(r)}`);
    }
  }
  return situacao(e.id, texto);
}

/** Uma passada por todas as estratégias com piloto ligado. Exportada para os testes. */
export async function rodadaPiloto(agora = Date.now()): Promise<void> {
  await garantirEstrategiaPadrao();
  const estrategias = await query<EstrategiaPiloto>(
    `select e.*, c.exchange, c.modo as conta_modo,
            coalesce(p.quantidade, 0) as quantidade, coalesce(p.custo_total, 0) as custo_total, p.maior_preco
       from estrategias e join contas c on c.id = e.conta_id left join posicoes p on p.estrategia_id = e.id
      where e.ativa and e.auto_ligado order by e.id`,
  );
  for (const e of estrategias) {
    try {
      await cuidar(e, agora);
    } catch (erro) {
      const msg = (erro as Error).message.slice(0, 200);
      logger.warn({ estrategia: e.id, err: msg }, 'piloto: falhou nesta passada');
      await situacao(e.id, `falhou nesta passada: ${msg}`).catch(() => undefined);
    }
  }
}

export function iniciarPiloto(): () => void {
  let rodando = false;
  const passo = async () => {
    if (rodando) return; // a passada anterior ainda espera o agente de IA
    rodando = true;
    try {
      await rodadaPiloto();
    } catch (erro) {
      logger.error({ err: (erro as Error).message }, 'piloto: erro na passada');
    } finally {
      rodando = false;
    }
  };
  const inicio = setTimeout(passo, 15_000);
  const timer = setInterval(passo, INTERVALO_MS);
  inicio.unref();
  timer.unref();
  return () => {
    clearTimeout(inicio);
    clearInterval(timer);
  };
}

// ------------------------------------------------------------------ estratégia padrão

/** O que a estratégia padrão usa: R$ 50, uma compra por vez em qualquer par em reais, agente obrigatório e stop de 3%. */
export const PADRAO = {
  nome: 'Piloto Binance em reais (padrão)',
  simbolo: 'BTC/BRL', // ponto de partida: a varredura troca para o par que virar para alta
  tempo: '15m',
  intervalo_min: 2,
  valor: 50,
  intervalo_min_seg: 3600, // uma hora entre ordens (o stop e as saídas passam por cima)
  desvio_max_pct: 1.5,
  ia_contexto: 'Capital pequeno (R$ 50) e a prioridade é não perder dinheiro: só aprove a compra com sinais claros a favor; na dúvida, vete.',
  stop: 3,
  alvo: 6,
  protecao: 2.5,
  recuo: 1.5,
};

/**
 * Cria uma vez a estratégia padrão na primeira conta Binance (a real, se houver), em SIMULAÇÃO e com
 * o piloto ligado. Operar real continua sendo decisão do dono (as três chaves).
 */
export async function garantirEstrategiaPadrao(): Promise<number | null> {
  const feita = await umOuNada('select 1 from configuracoes where chave = $1', ['estrategia_padrao']);
  if (feita) return null;
  const conta = await umOuNada<{ id: number }>(
    `select id from contas where exchange = 'binance' and not testnet order by (modo = 'real') desc, id limit 1`,
  );
  if (!conta) return null;
  const t = novoToken(); // ninguém vê este token: o piloto não precisa dele; o painel gera outro se quiser webhook
  const [nova] = await query<{ id: number }>(
    `insert into estrategias (nome, conta_id, simbolo, ativa, real, token_hash, token_prefixo, valor_ordem, limite_por_ordem,
                              limite_diario, limite_posicao, intervalo_min_seg, desvio_max_pct,
                              ia_modo, ia_tipo, ia_falha, ia_confianca_min, ia_nas_vendas, ia_contexto,
                              auto_ligado, auto_stop_pct, auto_alvo_pct, auto_protecao_pct, auto_recuo_pct,
                              auto_varrer, auto_tempo, auto_intervalo_min)
     values ($1, $2, $3, true, false, $4, $5, $6, $6, $6, $6, $7, $8,
             'obrigatorio', 'agente', 'reprova', 0.6, false, $9,
             true, $10, $11, $12, $13, true, $14, $15) returning id`,
    [PADRAO.nome, conta.id, PADRAO.simbolo, t.hash, t.prefixo, PADRAO.valor, PADRAO.intervalo_min_seg, PADRAO.desvio_max_pct,
      PADRAO.ia_contexto, PADRAO.stop, PADRAO.alvo, PADRAO.protecao, PADRAO.recuo, PADRAO.tempo, PADRAO.intervalo_min],
  );
  // saldo de mentira para a simulação, se a conta ainda não tem reais simulados
  await query(
    `insert into saldos_simulados (conta_id, moeda, quantidade) values ($1, 'BRL', $2) on conflict (conta_id, moeda) do nothing`,
    [conta.id, PADRAO.valor],
  );
  await query(`insert into configuracoes (chave, valor) values ('estrategia_padrao', $1)`, [JSON.stringify({ id: nova!.id })]);
  await query(`insert into eventos (tipo, detalhe) values ('estrategia_padrao_criada', $1)`, [JSON.stringify({ estrategia: nova!.id, conta: conta.id })]);
  logger.info({ estrategia: nova!.id, conta: conta.id }, 'estratégia padrão criada (simulação, piloto ligado)');
  return nova!.id;
}
