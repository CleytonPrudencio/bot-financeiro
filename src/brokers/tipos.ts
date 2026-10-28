export interface Execucao {
  /** quantidade da moeda base que entrou (compra) ou saiu (venda), já sem a taxa cobrada nela */
  quantidade: number;
  precoMedio: number;
  /** total em moeda de cotação: o que saiu (compra) ou entrou (venda), antes da taxa em cotação */
  custo: number;
  /** taxa em moeda de cotação (estimada quando a exchange cobra em outra moeda) */
  taxa: number;
  idExchange: string | null;
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
