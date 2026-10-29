import ccxt, { type Exchange, type Order } from 'ccxt';
import { moedas, type Corretora, type Execucao } from './tipos.js';

// Ponte para qualquer exchange suportada pelo CCXT (Binance, Mercado Bitcoin, Bybit, OKX…).
// Sem chaves, serve só para cotação pública (usada pela simulação).

export interface Credenciais {
  apiKey: string;
  secret: string;
  password?: string;
}

export function exchangesSuportadas(): string[] {
  return [...ccxt.exchanges].sort();
}

function criar(exchangeId: string, cred?: Credenciais, testnet = false): Exchange {
  const Classe = (ccxt as unknown as Record<string, new (o: object) => Exchange>)[exchangeId];
  if (!Classe || !ccxt.exchanges.includes(exchangeId)) throw new Error(`exchange "${exchangeId}" não suportada pelo CCXT`);
  const ex = new Classe({ enableRateLimit: true, timeout: 15_000, ...(cred ?? {}) });
  if (testnet) {
    if (!ex.urls?.test) throw new Error(`a exchange "${exchangeId}" não tem ambiente de teste (testnet)`);
    ex.setSandboxMode(true);
  }
  return ex;
}

// Uma instância por exchange (públicas) e por conta (com chave), para não recarregar os mercados
// a cada sinal.
const publicas = new Map<string, Promise<Exchange>>();
const privadas = new Map<string, { assinatura: string; ex: Promise<Exchange> }>();

async function carregar(ex: Exchange): Promise<Exchange> {
  await ex.loadMarkets();
  return ex;
}

export function exchangePublica(exchangeId: string): Promise<Exchange> {
  let p = publicas.get(exchangeId);
  if (!p) {
    p = carregar(criar(exchangeId));
    p.catch(() => publicas.delete(exchangeId));
    publicas.set(exchangeId, p);
  }
  return p;
}

export async function cotacaoPublica(exchangeId: string, simbolo: string): Promise<number> {
  const ex = await exchangePublica(exchangeId);
  const t = await ex.fetchTicker(simbolo);
  const preco = t.last ?? t.close ?? (t.bid && t.ask ? (t.bid + t.ask) / 2 : undefined);
  if (!preco) throw new Error(`a exchange não devolveu cotação para ${simbolo}`);
  return preco;
}

/** Velas diárias públicas (as mais recentes por último). */
export async function velasDiarias(exchangeId: string, simbolo: string, limite = 400) {
  const ex = await exchangePublica(exchangeId);
  if (!ex.has?.fetchOHLCV) throw new Error(`a ${exchangeId} não fornece velas (OHLCV)`);
  if (!ex.markets?.[simbolo]) throw new Error(`o par ${simbolo} não existe na ${exchangeId}`);
  const desde = Date.now() - limite * 86_400_000;
  const linhas = await ex.fetchOHLCV(simbolo, '1d', desde, limite);
  return linhas
    .filter((l) => l.every((x) => typeof x === 'number'))
    .map((l) => ({ t: l[0] as number, abre: l[1] as number, max: l[2] as number, min: l[3] as number, fecha: l[4] as number, volume: l[5] as number }));
}

export class CorretoraCcxt implements Corretora {
  private ex: Promise<Exchange>;

  constructor(contaId: number, exchangeId: string, cred: Credenciais, testnet: boolean, assinatura: string) {
    const chave = String(contaId);
    const atual = privadas.get(chave);
    if (atual && atual.assinatura === assinatura) {
      this.ex = atual.ex;
    } else {
      this.ex = carregar(criar(exchangeId, cred, testnet));
      this.ex.catch(() => privadas.delete(chave));
      privadas.set(chave, { assinatura, ex: this.ex });
    }
  }

  async cotacao(simbolo: string): Promise<number> {
    const t = await (await this.ex).fetchTicker(simbolo);
    const preco = t.last ?? t.close;
    if (!preco) throw new Error(`a exchange não devolveu cotação para ${simbolo}`);
    return preco;
  }

  async comprar(simbolo: string, valor: number, precoRef: number): Promise<Execucao> {
    const ex = await this.ex;
    let ordem: Order;
    if (ex.has.createMarketBuyOrderWithCost) {
      ordem = await ex.createMarketBuyOrderWithCost(simbolo, Number(ex.costToPrecision(simbolo, valor)));
    } else {
      // Exchanges sem compra "por valor" (Mercado Bitcoin, Foxbit…) pedem o preço junto para
      // calcular o total: vai a cotação atual, e a quantidade sai de valor / preço.
      const qtd = Number(ex.amountToPrecision(simbolo, valor / precoRef));
      ordem = await ex.createOrder(simbolo, 'market', 'buy', qtd, precoRef);
    }
    return this.resultado(ex, simbolo, ordem, precoRef);
  }

  async vender(simbolo: string, quantidade: number, precoRef: number): Promise<Execucao> {
    const ex = await this.ex;
    const qtd = Number(ex.amountToPrecision(simbolo, quantidade));
    const ordem = await ex.createOrder(simbolo, 'market', 'sell', qtd);
    return this.resultado(ex, simbolo, ordem, precoRef);
  }

  async saldos(): Promise<Record<string, number>> {
    const b = await (await this.ex).fetchBalance();
    const livres: Record<string, number> = {};
    for (const [moeda, valor] of Object.entries(b.free ?? {})) {
      if (typeof valor === 'number' && valor > 0) livres[moeda] = valor;
    }
    return livres;
  }

  /** Normaliza a resposta da exchange; busca a ordem de novo se ela voltou sem o preenchimento. */
  private async resultado(ex: Exchange, simbolo: string, ordem: Order, precoRef: number): Promise<Execucao> {
    let o = ordem;
    if (!o.filled && o.id && ex.has.fetchOrder) {
      try {
        o = await ex.fetchOrder(o.id, simbolo);
      } catch {
        // segue com o que veio: a ordem já foi aceita pela exchange
      }
    }
    const { base, cotacao } = moedas(simbolo);
    const preenchida = o.filled ?? o.amount ?? 0;
    const preco = o.average ?? o.price ?? (o.cost && preenchida ? o.cost / preenchida : precoRef);
    const custo = o.cost ?? preenchida * preco;
    let taxa = 0;
    let quantidade = preenchida;
    for (const f of o.fees?.length ? o.fees : o.fee ? [o.fee] : []) {
      if (!f?.cost) continue;
      if (f.currency === base) {
        // taxa cobrada na própria moeda comprada/vendida: sai da quantidade
        if (o.side === 'buy') quantidade -= f.cost;
        taxa += f.cost * preco;
      } else if (f.currency === cotacao) {
        taxa += f.cost;
      }
      // taxa em outra moeda (ex.: BNB) não entra no cálculo da posição
    }
    return { quantidade, precoMedio: preco, custo, taxa, idExchange: o.id ?? null };
  }
}
