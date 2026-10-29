import * as ccxt from './ccxt.js';
import { cotacaoMt5, MT5, paresMt5, velasMt5 } from './mt5.js';
import { B3, cotacaoB3, paresB3, velasB3 } from './b3.js';
import type { TempoVela } from './ccxt.js';

// Dados de mercado de qualquer conta: exchanges pelo CCXT, ações da B3 pela ponte MetaTrader 5
// ("mt5") e ações da B3 do assistente pelo Yahoo ("b3"). Quem precisa de cotação, velas ou da
// lista de pares usa daqui, e não do CCXT direto.

export { MS_DA_VELA, type TempoVela } from './ccxt.js';
export { MT5 } from './mt5.js';
export { B3 } from './b3.js';

/** Contas de ações da B3 (ponte ou assistente): seguem o pregão. */
export const ehB3 = (exchange: string) => exchange === MT5 || exchange === B3;

export const exchangesSuportadas = () => [B3, MT5, ...ccxt.exchangesSuportadas()];

export function cotacaoPublica(exchange: string, simbolo: string): Promise<number> {
  if (exchange === MT5) return cotacaoMt5(simbolo);
  if (exchange === B3) return cotacaoB3(simbolo);
  return ccxt.cotacaoPublica(exchange, simbolo);
}

export function velas(exchange: string, simbolo: string, tempo: TempoVela, limite = 400) {
  if (exchange === MT5) return velasMt5(simbolo, tempo, limite);
  if (exchange === B3) return velasB3(simbolo, tempo, limite);
  return ccxt.velas(exchange, simbolo, tempo, limite);
}

export const velasDiarias = (exchange: string, simbolo: string, limite = 400) => velas(exchange, simbolo, '1d', limite);

export function paresDaMoeda(exchange: string, moeda: string, volumeMin: number) {
  if (exchange === MT5) return paresMt5(volumeMin);
  if (exchange === B3) return paresB3(volumeMin);
  return ccxt.paresDaMoeda(exchange, moeda, volumeMin);
}

/** Os pares que existem na exchange. Na ponte MT5, os que ela está mandando agora. */
export async function mercadosDa(exchange: string): Promise<Record<string, unknown>> {
  if (exchange === B3) return Object.fromEntries((await paresB3(0)).map((p) => [p.simbolo, {}]));
  if (exchange !== MT5) return (await ccxt.exchangePublica(exchange)).markets ?? {};
  return Object.fromEntries((await paresMt5(0)).map((p) => [p.simbolo, {}]));
}
