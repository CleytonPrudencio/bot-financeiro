// Leitura do gráfico público do Yahoo Finance (função pura, sem rede nem banco: os testes usam direto).

export interface Grafico {
  preco: number | null;
  velas: { t: number; abre: number; max: number; min: number; fecha: number; volume: number }[];
}


/** Lê a resposta do gráfico do Yahoo (exportada para os testes). */
export function lerGrafico(json: unknown): Grafico {
  const r = (json as { chart?: { result?: unknown[]; error?: { description?: string } | null } })?.chart;
  if (r?.error) throw new Error(`Yahoo: ${r.error.description ?? 'erro'}`);
  const g = r?.result?.[0] as
    | { meta?: { regularMarketPrice?: number }; timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] } }
    | undefined;
  if (!g) throw new Error('Yahoo não devolveu o gráfico');
  const q = g.indicators?.quote?.[0] ?? {};
  const velas = (g.timestamp ?? []).flatMap((t, i) => {
    const v = { t: t * 1000, abre: q.open?.[i], max: q.high?.[i], min: q.low?.[i], fecha: q.close?.[i], volume: q.volume?.[i] ?? 0 };
    // vela sem negócio vem com null: fica de fora
    return [v.abre, v.max, v.min, v.fecha].every((x) => typeof x === 'number' && x > 0) ? [v as Grafico['velas'][number]] : [];
  });
  return { preco: g.meta?.regularMarketPrice ?? velas[velas.length - 1]?.fecha ?? null, velas };
}
