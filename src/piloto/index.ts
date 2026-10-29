import { config } from '../config.js';
import { novoToken } from '../crypto.js';
import { query, umOuNada } from '../db.js';
import { logger } from '../logger.js';
import { cotacaoPublica, velasDiarias } from '../brokers/ccxt.js';
import { moedas } from '../brokers/tipos.js';
import { corretoraReal, processarSinalDa, type Conta, type Estrategia, type Resultado } from '../motor.js';
import { kronosLigado, preverKronos } from '../previsao/kronos.js';
import { conferirSaida } from '../risco.js';
import { avaliarEntrada, DIA_MS, KRONOS_MIN_ALTA, tendenciaQuebrou, velasFechadas } from './regras.js';

// Piloto automático: o bot gera os próprios sinais das estratégias com "piloto ligado" e manda pelo
// mesmo caminho do webhook (processarSinalDa). Então vale tudo: regras de risco, trava por
// estratégia, agente de IA nas compras e as três chaves do dinheiro real. O piloto não cria
// atalho nenhum: ele só decide QUANDO pedir.
//
// - a cada minuto: cotação de cada estratégia com posição aberta → stop, alvo ou proteção do ganho;
// - uma vez por vela diária fechada: entrada (virada da tendência) ou saída por tendência.

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

async function situacao(id: number, texto: string, extra: { vela?: number } = {}): Promise<void> {
  await query(
    `update estrategias set auto_situacao = $2, auto_checado_em = now(), auto_ultima_vela = coalesce($3, auto_ultima_vela) where id = $1`,
    [id, texto.slice(0, 500), extra.vela ?? null],
  );
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

async function cuidar(e: EstrategiaPiloto, agora: number): Promise<void> {
  const preco = await cotacaoPublica(e.exchange, e.simbolo);
  const temPosicao = e.quantidade > 0;
  let texto = '';

  if (temPosicao) {
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
      return situacao(e.id, `${saida.motivo} → ${textoResultado(r)}`);
    }
    texto = `posição aberta: ${pct((preco / precoMedio - 1) * 100)} desde a compra; stop em ${(precoMedio * (1 - e.auto_stop_pct / 100)).toPrecision(6)}`;
  }

  // uma vez por vela diária fechada
  const ultimaFechada = Math.floor(agora / DIA_MS) * DIA_MS - DIA_MS;
  if (e.auto_ultima_vela !== null && e.auto_ultima_vela >= ultimaFechada) {
    if (texto) await situacao(e.id, texto);
    else await query('update estrategias set auto_checado_em = now() where id = $1', [e.id]);
    return;
  }
  const velas = await velasDiarias(e.exchange, e.simbolo, 400);
  const fechadas = velasFechadas(velas, agora);
  const vela = fechadas[fechadas.length - 1]?.t ?? ultimaFechada;

  if (temPosicao) {
    const quebra = tendenciaQuebrou(fechadas);
    if (quebra) {
      const r = await processarSinalDa(e.id, { acao: 'zerar', preco, id: `piloto-tendencia-${vela}` }, ORIGEM);
      logger.info({ estrategia: e.id, resultado: textoResultado(r) }, 'piloto: saída por tendência');
      return situacao(e.id, `${quebra} → ${textoResultado(r)}`, { vela });
    }
    return situacao(e.id, texto, { vela });
  }

  const entrada = avaliarEntrada(fechadas);
  if (!entrada.comprar) return situacao(e.id, entrada.motivo, { vela });

  // corte pelo Kronos antes de gastar IA (fora do ar: segue, e o agente decide sem a previsão)
  if (kronosLigado()) {
    try {
      const p = await preverKronos(velasFechadas(velas, agora));
      if (p.prob_alta < KRONOS_MIN_ALTA) {
        return situacao(e.id, `${entrada.motivo}, mas o Kronos dá só ${Math.round(p.prob_alta * 100)}% de chance de alta: não entra`, { vela });
      }
    } catch (erro) {
      logger.warn({ estrategia: e.id, err: (erro as Error).message }, 'piloto: Kronos fora; segue sem a previsão');
    }
  }

  const valor = await valorDaCompra(e);
  if (valor === null) return situacao(e.id, `${entrada.motivo}, mas não há saldo livre para comprar`, { vela });
  const r = await processarSinalDa(e.id, { acao: 'comprar', preco, valor, id: `piloto-entrada-${vela}` }, ORIGEM);
  logger.info({ estrategia: e.id, resultado: textoResultado(r) }, 'piloto: entrada');
  return situacao(e.id, `${entrada.motivo} → ${textoResultado(r)}`, { vela });
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

/** O que a estratégia padrão usa: R$ 50, uma compra por vez, agente obrigatório e stop de 3%. */
export const PADRAO = {
  nome: 'Piloto BTC/BRL (padrão)',
  simbolo: 'BTC/BRL',
  valor: 50,
  intervalo_min_seg: 6 * 3600,
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
                              auto_ligado, auto_stop_pct, auto_alvo_pct, auto_protecao_pct, auto_recuo_pct)
     values ($1, $2, $3, true, false, $4, $5, $6, $6, $6, $6, $7, $8,
             'obrigatorio', 'agente', 'reprova', 0.6, false, $9,
             true, $10, $11, $12, $13) returning id`,
    [PADRAO.nome, conta.id, PADRAO.simbolo, t.hash, t.prefixo, PADRAO.valor, PADRAO.intervalo_min_seg, PADRAO.desvio_max_pct,
      PADRAO.ia_contexto, PADRAO.stop, PADRAO.alvo, PADRAO.protecao, PADRAO.recuo],
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
