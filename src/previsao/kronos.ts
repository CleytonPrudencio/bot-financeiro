import { config } from '../config.js';
import type { Vela } from '../analise/indicadores.js';

// Cliente do serviço de previsão do Kronos (container bot-kronos). A previsão é um dado a mais para
// as IAs: nunca decide nada sozinha. Fora do ar, quem chama segue sem ela.

export interface PrevisaoKronos {
  modelo: string;
  horizonte: number;
  caminhos: number;
  ultimo: number;
  datas: string[];
  mediana: number[];
  p10: number[];
  p90: number[];
  retorno_mediano_pct: number;
  retorno_p10_pct: number;
  retorno_p90_pct: number;
  prob_alta: number;
  ms: number;
}

export const kronosLigado = () => Boolean(config.kronosUrl);

export async function saudeKronos(): Promise<{ ok: boolean; modelo?: string; erro?: string }> {
  if (!config.kronosUrl) return { ok: false, erro: 'KRONOS_URL não configurado' };
  try {
    const r = await fetch(`${config.kronosUrl}/saude`, { signal: AbortSignal.timeout(4000) });
    const d = (await r.json()) as { ok?: boolean; modelo?: string };
    return r.ok && d.ok ? { ok: true, modelo: d.modelo } : { ok: false, erro: `respondeu ${r.status}` };
  } catch {
    return { ok: false, erro: 'serviço do Kronos fora do ar' };
  }
}

export async function preverKronos(velas: Vela[], horizonte = 5, caminhos = 16): Promise<PrevisaoKronos> {
  if (!config.kronosUrl) throw new Error('Kronos não configurado');
  let r: Response;
  try {
    r = await fetch(`${config.kronosUrl}/prever`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ velas: velas.slice(-400), horizonte, caminhos }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    throw new Error((e as Error).name === 'TimeoutError' ? 'o Kronos demorou demais' : 'serviço do Kronos fora do ar');
  }
  const d = (await r.json().catch(() => ({}))) as PrevisaoKronos & { erro?: string };
  if (!r.ok) throw new Error(`Kronos: ${d.erro ?? `erro ${r.status}`}`.slice(0, 200));
  return d;
}

/** Resumo curto para ir junto dos dados de mercado que as IAs leem. */
export function resumoParaIa(p: PrevisaoKronos) {
  return {
    modelo: p.modelo,
    horizonte_dias: p.horizonte,
    caminhos_simulados: p.caminhos,
    retorno_mediano_pct: p.retorno_mediano_pct,
    faixa_10_a_90_pct: [p.retorno_p10_pct, p.retorno_p90_pct],
    chance_de_terminar_acima: p.prob_alta,
    observacao: 'previsão estatística das velas; não é garantia',
  };
}
