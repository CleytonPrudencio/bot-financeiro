import * as ccxt from './ccxt.js';
import { cotacaoMt5, MT5, paresMt5, velasMt5 } from './mt5.js';
import type { TempoVela } from './ccxt.js';

// Dados de mercado de qualquer conta: exchanges pelo CCXT e ações da B3 pela ponte MetaTrader 5
// ("mt5"). Quem precisa de cotação, velas ou da lista de pares usa daqui, e não do CCXT direto.

export { MS_DA_VELA, type TempoVela } from './ccxt.js';
export { MT5 } from './mt5.js';

export const exchangesSuportadas = () => [MT5, ...ccxt.exchangesSuportadas()];

export function cotacaoPublica(exchange: string, simbolo: string): Promise<number> {
  return exchange === MT5 ? cotacaoMt5(simbolo) : ccxt.cotacaoPublica(exchange, simbolo);
}

export function velas(exchange: string, simbolo: string, tempo: TempoVela, limite = 400) {
  return exchange === MT5 ? velasMt5(simbolo, tempo, limite) : ccxt.velas(exchange, simbolo, tempo, limite);
}

export const velasDiarias = (exchange: string, simbolo: string, limite = 400) => velas(exchange, simbolo, '1d', limite);

export function paresDaMoeda(exchange: string, moeda: string, volumeMin: number) {
  return exchange === MT5 ? paresMt5(volumeMin) : ccxt.paresDaMoeda(exchange, moeda, volumeMin);
}

/** Os pares que existem na exchange. Na ponte MT5, os que ela está mandando agora. */
export async function mercadosDa(exchange: string): Promise<Record<string, unknown>> {
  if (exchange !== MT5) return (await ccxt.exchangePublica(exchange)).markets ?? {};
  return Object.fromEntries((await paresMt5(0)).map((p) => [p.simbolo, {}]));
}
