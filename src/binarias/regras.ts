import { ifr, macd, mediaSimples, type Vela } from '../analise/indicadores.js';

// Quando apostar e para que lado, em funções puras (os testes cobrem cada uma). Olha só velas de
// 1 min JÁ FECHADAS da própria Quotex (no OTC o preço é dela, não do mercado lá fora).
//
// - repique (padrão): aposta na volta depois do exagero. IFR da vela anterior abaixo de 30 e a
//   última vela fechou verde com o IFR subindo → "call" (acima). O espelho (IFR acima de 70, vela
//   vermelha, IFR caindo) → "put" (abaixo).
// - tendência: aposta a favor do movimento. Preço acima da média de 20 e esta acima da de 50, MACD
//   positivo, IFR entre 50 e 70 e a última vela verde → "call". O espelho → "put".
//
// Nada disso garante acerto: em 1 a 5 min o preço é quase cara ou coroa. O painel mostra a taxa
// de acerto real para o dono ver se passa do que o payout exige.

export const VELA_MS = 60_000;
export const IFR_BAIXO = 30;
export const IFR_ALTO = 70;
const MIN_VELAS = 61;

export type Direcao = 'call' | 'put';
export type Leitura = { direcao: Direcao; motivo: string } | { direcao: null; motivo: string };

/** Velas da ponte ([t_ms, abre, max, min, fecha]) no formato do bot, só as fechadas, em ordem. */
export function velasQuotex(linhas: unknown, agora: number): Vela[] {
  if (!Array.isArray(linhas)) return [];
  const velas: Vela[] = [];
  for (const l of linhas) {
    if (!Array.isArray(l) || l.length < 5 || !l.slice(0, 5).every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    const [t, abre, max, min, fecha] = l as number[];
    if (t! + VELA_MS <= agora) velas.push({ t: t!, abre: abre!, max: max!, min: min!, fecha: fecha!, volume: 0 });
  }
  velas.sort((a, b) => a.t - b.t);
  return velas.filter((v, i) => i === 0 || v.t !== velas[i - 1]!.t);
}

export function lerRepique(velas: Vela[]): Leitura {
  if (velas.length < MIN_VELAS) return { direcao: null, motivo: `poucas velas (${velas.length} de ${MIN_VELAS})` };
  const fechamentos = velas.map((v) => v.fecha);
  const agora = ifr(fechamentos);
  const antes = ifr(fechamentos.slice(0, -1));
  if (agora === null || antes === null) return { direcao: null, motivo: 'indicadores indisponíveis' };
  const ultima = velas[velas.length - 1]!;
  const fmt = (n: number) => n.toFixed(0);
  if (antes < IFR_BAIXO) {
    if (ultima.fecha > ultima.abre && agora > antes) return { direcao: 'call', motivo: `repique: IFR saiu de ${fmt(antes)} (vendido demais) e a vela fechou verde` };
    return { direcao: null, motivo: `vendido demais (IFR ${fmt(antes)}), esperando a vela de volta` };
  }
  if (antes > IFR_ALTO) {
    if (ultima.fecha < ultima.abre && agora < antes) return { direcao: 'put', motivo: `repique: IFR caiu de ${fmt(antes)} (comprado demais) e a vela fechou vermelha` };
    return { direcao: null, motivo: `comprado demais (IFR ${fmt(antes)}), esperando a vela de volta` };
  }
  return { direcao: null, motivo: `sem exagero (IFR ${fmt(antes)})` };
}

export function lerTendencia(velas: Vela[]): Leitura {
  if (velas.length < MIN_VELAS) return { direcao: null, motivo: `poucas velas (${velas.length} de ${MIN_VELAS})` };
  const fechamentos = velas.map((v) => v.fecha);
  const m20 = mediaSimples(fechamentos, 20);
  const m50 = mediaSimples(fechamentos, 50);
  const i = ifr(fechamentos);
  const m = macd(fechamentos);
  if (m20 === null || m50 === null || i === null || !m) return { direcao: null, motivo: 'indicadores indisponíveis' };
  const ultima = velas[velas.length - 1]!;
  const preco = ultima.fecha;
  if (preco > m20 && m20 > m50 && m.histograma > 0 && i >= 50 && i <= IFR_ALTO && ultima.fecha > ultima.abre) {
    return { direcao: 'call', motivo: `tendência de alta: acima das médias de 20 e 50, MACD positivo, IFR ${i.toFixed(0)}` };
  }
  if (preco < m20 && m20 < m50 && m.histograma < 0 && i <= 50 && i >= IFR_BAIXO && ultima.fecha < ultima.abre) {
    return { direcao: 'put', motivo: `tendência de baixa: abaixo das médias de 20 e 50, MACD negativo, IFR ${i.toFixed(0)}` };
  }
  return { direcao: null, motivo: `sem tendência clara (IFR ${i.toFixed(0)})` };
}

export function lerSinal(velas: Vela[], estilo: 'repique' | 'tendencia'): Leitura {
  return estilo === 'tendencia' ? lerTendencia(velas) : lerRepique(velas);
}

/** Payout do prazo: a Quotex informa o de 1 min e o de 5 min; abaixo de 5 min vale o de 1 min. */
export function payoutDoPrazo(prazoS: number, p1m: number | null, p5m: number | null): number | null {
  return prazoS < 300 ? p1m : p5m;
}

/** Perdas seguidas na ponta: resultados do mais recente para o mais antigo, para no primeiro ganho. */
export function perdasSeguidas(resultados: ('ganhou' | 'perdeu' | 'empate')[]): number {
  let n = 0;
  for (const r of resultados) {
    if (r === 'ganhou') break;
    if (r === 'perdeu') n += 1;
  }
  return n;
}
