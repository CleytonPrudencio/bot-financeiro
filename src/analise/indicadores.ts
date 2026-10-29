// Indicadores técnicos calculados aqui mesmo, a partir das velas diárias da exchange. Os agentes
// de IA recebem estes números prontos em vez de "achar" o RSI ou a média de 200 dias.

export interface Vela {
  t: number; // abertura, em ms
  abre: number;
  max: number;
  min: number;
  fecha: number;
  volume: number;
}

export function mediaSimples(v: number[], n: number): number | null {
  if (v.length < n || n <= 0) return null;
  let s = 0;
  for (let i = v.length - n; i < v.length; i++) s += v[i]!;
  return s / n;
}

/** Série da média exponencial (o primeiro valor é a média simples dos n primeiros). */
export function serieExponencial(v: number[], n: number): number[] {
  if (v.length < n) return [];
  const k = 2 / (n + 1);
  let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const saida = [e];
  for (let i = n; i < v.length; i++) {
    e = v[i]! * k + e * (1 - k);
    saida.push(e);
  }
  return saida;
}

/** IFR (RSI) de Wilder. */
export function ifr(v: number[], n = 14): number | null {
  if (v.length <= n) return null;
  let ganho = 0;
  let perda = 0;
  for (let i = 1; i <= n; i++) {
    const d = v[i]! - v[i - 1]!;
    if (d >= 0) ganho += d;
    else perda -= d;
  }
  ganho /= n;
  perda /= n;
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i]! - v[i - 1]!;
    ganho = (ganho * (n - 1) + Math.max(d, 0)) / n;
    perda = (perda * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (perda === 0) return 100;
  return 100 - 100 / (1 + ganho / perda);
}

export function macd(v: number[]): { linha: number; sinal: number; histograma: number } | null {
  const rapida = serieExponencial(v, 12);
  const lenta = serieExponencial(v, 26);
  if (!lenta.length) return null;
  const linhaSerie = lenta.map((l, i) => rapida[i + 14]! - l); // alinha as duas no fim
  const sinalSerie = serieExponencial(linhaSerie, 9);
  if (!sinalSerie.length) return null;
  const linha = linhaSerie[linhaSerie.length - 1]!;
  const sinal = sinalSerie[sinalSerie.length - 1]!;
  return { linha, sinal, histograma: linha - sinal };
}

function desvio(v: number[]): number {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

/** Posição do preço na banda de Bollinger (0 = banda de baixo, 1 = de cima) e largura relativa. */
export function bollinger(v: number[], n = 20): { posicao: number; largura_pct: number } | null {
  if (v.length < n) return null;
  const janela = v.slice(-n);
  const m = janela.reduce((a, b) => a + b, 0) / n;
  const d = desvio(janela);
  if (d === 0) return { posicao: 0.5, largura_pct: 0 };
  const cima = m + 2 * d;
  const baixo = m - 2 * d;
  return { posicao: (v[v.length - 1]! - baixo) / (cima - baixo), largura_pct: ((cima - baixo) / m) * 100 };
}

/** ATR de Wilder, em % do último fechamento. */
export function atrPct(velas: Vela[], n = 14): number | null {
  if (velas.length <= n) return null;
  const tr = velas.slice(1).map((c, i) => {
    const anterior = velas[i]!.fecha;
    return Math.max(c.max - c.min, Math.abs(c.max - anterior), Math.abs(c.min - anterior));
  });
  let atr = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < tr.length; i++) atr = (atr * (n - 1) + tr[i]!) / n;
  return (atr / velas[velas.length - 1]!.fecha) * 100;
}

/** Volatilidade anualizada (%) dos retornos diários dos últimos n dias. Cripto negocia 365 dias. */
export function volatilidadeAnual(v: number[], n: number, diasNoAno = 365): number | null {
  if (v.length <= n) return null;
  const r = [];
  for (let i = v.length - n; i < v.length; i++) r.push(Math.log(v[i]! / v[i - 1]!));
  return desvio(r) * Math.sqrt(diasNoAno) * 100;
}

/** Maior queda de um topo até um fundo seguinte (%), e a queda atual desde o topo. */
export function quedas(v: number[]): { maxima_pct: number; atual_pct: number } {
  let topo = -Infinity;
  let maxima = 0;
  for (const p of v) {
    topo = Math.max(topo, p);
    maxima = Math.max(maxima, (topo - p) / topo);
  }
  const ultimo = v[v.length - 1] ?? 0;
  return { maxima_pct: maxima * 100, atual_pct: topo > 0 ? ((topo - ultimo) / topo) * 100 : 0 };
}

export function retornoPct(v: number[], dias: number): number | null {
  if (v.length <= dias) return null;
  return (v[v.length - 1]! / v[v.length - 1 - dias]! - 1) * 100;
}

const r2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** Resumo técnico que vai para os agentes. `referencia` = fechamentos do BTC, para força relativa. */
export function resumoTecnico(velas: Vela[], referencia?: number[]) {
  const f = velas.map((c) => c.fecha);
  const vol = velas.map((c) => c.volume);
  const preco = f[f.length - 1] ?? null;
  const ano = f.slice(-365);
  const m20 = mediaSimples(f, 20);
  const m50 = mediaSimples(f, 50);
  const m200 = mediaSimples(f, 200);
  const md = macd(f);
  const bb = bollinger(f);
  const q = quedas(ano);
  const forca = (dias: number) => {
    const a = retornoPct(f, dias);
    const b = referencia ? retornoPct(referencia, dias) : null;
    return a === null || b === null ? null : r2(a - b);
  };
  return {
    preco: r2(preco),
    dias_de_historico: f.length,
    variacao_1d_pct: r2(retornoPct(f, 1)),
    retorno_7d_pct: r2(retornoPct(f, 7)),
    retorno_30d_pct: r2(retornoPct(f, 30)),
    retorno_90d_pct: r2(retornoPct(f, 90)),
    retorno_180d_pct: r2(retornoPct(f, 180)),
    maxima_52s: r2(Math.max(...ano)),
    minima_52s: r2(Math.min(...ano)),
    media_20d: r2(m20),
    media_50d: r2(m50),
    media_200d: r2(m200),
    preco_vs_media_50d_pct: m50 && preco ? r2((preco / m50 - 1) * 100) : null,
    preco_vs_media_200d_pct: m200 && preco ? r2((preco / m200 - 1) * 100) : null,
    ifr_14: r2(ifr(f)),
    macd: md ? { linha: r2(md.linha), sinal: r2(md.sinal), histograma: r2(md.histograma) } : null,
    bollinger_20: bb ? { posicao: r2(bb.posicao), largura_pct: r2(bb.largura_pct) } : null,
    atr_14_pct: r2(atrPct(velas)),
    volatilidade_30d_anual_pct: r2(volatilidadeAnual(f, 30)),
    volatilidade_90d_anual_pct: r2(volatilidadeAnual(f, 90)),
    queda_maxima_1a_pct: r2(q.maxima_pct),
    queda_desde_topo_pct: r2(q.atual_pct),
    volume_ultimo_vs_media_20d: mediaSimples(vol, 20) ? r2(vol[vol.length - 1]! / mediaSimples(vol, 20)!) : null,
    volume_media_20d_vs_50d: mediaSimples(vol, 50) ? r2(mediaSimples(vol, 20)! / mediaSimples(vol, 50)!) : null,
    forca_relativa_vs_btc_30d_pct: forca(30),
    forca_relativa_vs_btc_90d_pct: forca(90),
    ultimas_5_velas: velas.slice(-5).map((c) => ({ dia: new Date(c.t).toISOString().slice(0, 10), abre: r2(c.abre), max: r2(c.max), min: r2(c.min), fecha: r2(c.fecha) })),
  };
}
