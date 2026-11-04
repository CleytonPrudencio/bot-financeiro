export interface Execucao {
  /** quantidade da moeda base que entrou (compra) ou saiu (venda), já sem a taxa cobrada nela */
  quantidade: number;
  precoMedio: number;
  /** total em moeda de cotação: o que saiu (compra) ou entrou (venda), antes da taxa em cotação */
  custo: number;
  /** taxa em moeda de cotação (estimada quando a exchange cobra em outra moeda) */
  taxa: number;
  idExchange: string | null;
  /** venda: o que sobrou por ser menor que o passo da exchange (ex.: 0,38 PEPE, que só se vende inteiro) */
  poeira?: number;
}

/**
 * O que sobrou da posição é pequeno demais para a exchange aceitar a venda (abaixo do passo, da
 * quantidade mínima ou do valor mínimo da ordem). Fica na carteira como "poeira"; o bot zera a posição.
 */
export class ErroPoeira extends Error {
  constructor(readonly quantidade: number, motivo: string) {
    super(motivo);
  }
}

/**
 * A venda arredondada pela exchange (`vendivel`) ainda é uma ordem que ela aceita? Null se sim; senão,
 * o motivo. Função pura (testada).
 */
export function motivoPoeira(vendivel: number, preco: number, minimos: { quantidade?: number | null; valor?: number | null }): string | null {
  if (!(vendivel > 0)) return 'menor que o passo de quantidade da exchange';
  if (minimos.quantidade && vendivel < minimos.quantidade) return `abaixo da quantidade mínima da exchange (${minimos.quantidade})`;
  if (minimos.valor && preco > 0 && vendivel * preco < minimos.valor) return `abaixo do valor mínimo de ordem da exchange (${minimos.valor})`;
  return null;
}

/** Uma exchange (ou a simulação dela) do ponto de vista do robô. */
export interface Corretora {
  cotacao(simbolo: string): Promise<number>;
  comprar(simbolo: string, valor: number, precoRef: number): Promise<Execucao>;
  vender(simbolo: string, quantidade: number, precoRef: number): Promise<Execucao>;
  saldos(): Promise<Record<string, number>>;
}

export function moedas(simbolo: string): { base: string; cotacao: string } {
  const [base, cotacao] = simbolo.split('/');
  if (!base || !cotacao) throw new Error(`par "${simbolo}" inválido: use o formato BASE/COTACAO, ex. BTC/USDT`);
  return { base, cotacao: cotacao.split(':')[0]! };
}
