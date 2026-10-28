import { z } from 'zod';

// Formato do sinal que chega no webhook. Pensado para o "Message" de um alerta do TradingView,
// que manda o texto do alerta como corpo:
//
//   {"acao":"comprar","simbolo":"{{ticker}}","preco":{{close}},"id":"{{timenow}}"}
//
// Só "acao" é obrigatória. Sem "simbolo" vale o par da estratégia; sem "valor" vale o valor de
// ordem da estratégia.

export type Acao = 'comprar' | 'vender' | 'zerar';

const SINONIMOS: Record<string, Acao> = {
  comprar: 'comprar', compra: 'comprar', buy: 'comprar', long: 'comprar',
  vender: 'vender', venda: 'vender', sell: 'vender',
  zerar: 'zerar', fechar: 'zerar', close: 'zerar', exit: 'zerar', flat: 'zerar',
};

const numeroPositivo = z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, 'precisa ser número maior que zero');

const esquema = z.object({
  acao: z.string().trim().toLowerCase(),
  simbolo: z.string().trim().min(1).max(40).optional(),
  valor: numeroPositivo.optional(),
  quantidade: numeroPositivo.optional(),
  preco: numeroPositivo.optional(),
  id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(120)).optional(),
});

export interface Sinal {
  acao: Acao;
  simbolo?: string;
  valor?: number;
  quantidade?: number;
  preco?: number;
  id?: string;
}

export type LeituraSinal = { ok: true; sinal: Sinal } | { ok: false; motivo: string };

/** Lê o corpo do webhook (objeto JSON ou texto com JSON dentro). */
export function lerSinal(corpo: unknown): LeituraSinal {
  let bruto = corpo;
  if (typeof bruto === 'string') {
    try {
      bruto = JSON.parse(bruto);
    } catch {
      return { ok: false, motivo: 'corpo não é JSON' };
    }
  }
  const r = esquema.safeParse(bruto);
  if (!r.success) {
    const p = r.error.issues[0];
    return { ok: false, motivo: `campo "${p?.path.join('.') || '?'}": ${p?.message ?? 'inválido'}` };
  }
  const acao = SINONIMOS[r.data.acao];
  if (!acao) return { ok: false, motivo: `ação "${r.data.acao}" desconhecida (use comprar, vender ou zerar)` };
  return {
    ok: true,
    sinal: {
      acao,
      simbolo: r.data.simbolo ? normalizarSimbolo(r.data.simbolo) : undefined,
      valor: r.data.valor,
      quantidade: r.data.quantidade,
      preco: r.data.preco,
      id: r.data.id,
    },
  };
}

/**
 * Aceita "BTC/USDT", "btc/usdt", "BTCUSDT" (como o TradingView manda) e "BINANCE:BTCUSDT".
 * Sem barra, só dá para comparar com o par da estratégia sem a barra: ver `mesmoSimbolo`.
 */
export function normalizarSimbolo(s: string): string {
  const semPrefixo = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  return semPrefixo.trim().toUpperCase();
}

export function mesmoSimbolo(doSinal: string, daEstrategia: string): boolean {
  const a = normalizarSimbolo(doSinal);
  const b = normalizarSimbolo(daEstrategia);
  return a === b || a.replace('/', '') === b.replace('/', '');
}
