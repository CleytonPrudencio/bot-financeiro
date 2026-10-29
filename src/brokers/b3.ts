import { config } from '../config.js';
import { query } from '../db.js';
import type { Corretora, Execucao } from './tipos.js';
import type { TempoVela } from './ccxt.js';
import { lerGrafico, type Grafico } from './grafico.js';

// Ações da B3 para o assistente (conta "b3"): cotação e velas do gráfico público do Yahoo Finance
// (PETR4/BRL no bot = PETR4.SA lá). Sem chave; a cotação vem com uns 15 min de atraso, o que basta
// para um assistente de velas diárias. O bot NUNCA manda ordem por aqui: no dinheiro real, quem
// executa é o dono, na corretora dele, a partir do aviso (src/assistente/).

export const B3 = 'b3';

const paraYahoo = (simbolo: string) => `${simbolo.split('/')[0]!.toUpperCase()}.SA`;

// O Yahoo não tem vela de 4 h; as outras, com o maior histórico que ele dá para cada tempo.
const INTERVALO: Partial<Record<TempoVela, { intervalo: string; periodo: string }>> = {
  '5m': { intervalo: '5m', periodo: '30d' },
  '15m': { intervalo: '15m', periodo: '60d' },
  '1h': { intervalo: '60m', periodo: '730d' },
  '1d': { intervalo: '1d', periodo: '2y' },
};
const VALIDADE_MS: Record<string, number> = { '5m': 60_000, '15m': 120_000, '1h': 300_000, '1d': 1_800_000, cotacao: 60_000 };

const cache = new Map<string, { ate: number; dado: Promise<Grafico> }>();

async function buscar(simbolo: string, tempo: TempoVela): Promise<Grafico> {
  const p = INTERVALO[tempo];
  if (!p) throw new Error(`velas de ${tempo} não existem para ações da B3 (use 5m, 15m, 1h ou 1d)`);
  const chave = `${simbolo}|${tempo}`;
  const atual = cache.get(chave);
  if (atual && atual.ate > Date.now()) return atual.dado;
  const url = `${config.b3CotacoesUrl}/v8/finance/chart/${encodeURIComponent(paraYahoo(simbolo))}?range=${p.periodo}&interval=${p.intervalo}`;
  const dado = (async () => {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (bot-financeiro)' }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) throw new Error(`a ação ${simbolo.split('/')[0]} não existe na B3 (ou o Yahoo não tem)`);
    if (!r.ok) throw new Error(`cotações da B3 indisponíveis agora (Yahoo respondeu ${r.status})`);
    return lerGrafico(await r.json());
  })();
  cache.set(chave, { ate: Date.now() + (VALIDADE_MS[tempo] ?? 60_000), dado });
  dado.catch(() => cache.delete(chave));
  return dado;
}

export async function cotacaoB3(simbolo: string): Promise<number> {
  const g = await buscar(simbolo, '15m').catch(() => buscar(simbolo, '1d'));
  if (!g.preco) throw new Error(`sem cotação de ${simbolo}`);
  return g.preco;
}

export async function velasB3(simbolo: string, tempo: TempoVela, limite = 400) {
  return (await buscar(simbolo, tempo)).velas.slice(-limite);
}

/** As ações do universo do assistente, com o giro do último dia (volume x fechamento). */
export async function paresB3(volumeMin: number) {
  const [cfg] = await query<{ valor: string[] }>(`select valor from configuracoes where chave = 'b3_universo'`);
  const lidos = await Promise.allSettled(
    (cfg?.valor ?? []).map(async (codigo) => {
      const simbolo = `${codigo.toUpperCase()}/BRL`;
      const g = await buscar(simbolo, '1d');
      const ultima = g.velas[g.velas.length - 1];
      const anterior = g.velas[g.velas.length - 2];
      return {
        simbolo,
        volume: ultima ? ultima.volume * ultima.fecha : 0,
        preco: g.preco,
        variacao_pct: g.preco && anterior ? (g.preco / anterior.fecha - 1) * 100 : null,
      };
    }),
  );
  return lidos
    .flatMap((l) => (l.status === 'fulfilled' ? [l.value] : []))
    .filter((p) => p.volume >= volumeMin)
    .sort((a, b) => b.volume - a.volume);
}

/** A "corretora" da conta assistida: só cota. Ordem de verdade é o dono quem manda, na corretora. */
export class CorretoraAssistida implements Corretora {
  cotacao(simbolo: string): Promise<number> {
    return cotacaoB3(simbolo);
  }
  async comprar(): Promise<Execucao> {
    throw new Error('conta assistida: o bot não manda ordem; o dono executa na corretora a partir do aviso');
  }
  async vender(): Promise<Execucao> {
    throw new Error('conta assistida: o bot não manda ordem; o dono executa na corretora a partir do aviso');
  }
  async saldos(): Promise<Record<string, number>> {
    return {};
  }
}
