import type { Execucao } from './tipos.js';

// A simulação executa a ordem inteira a mercado na cotação pública da exchange, cobra a
// taxa configurada na conta e não tem derrapagem. É otimista: o resultado real costuma ser um
// pouco pior.

export function simularCompra(valor: number, preco: number, taxaPct: number): Execucao {
  if (!(preco > 0)) throw new Error('sem preço para simular a compra');
  const taxa = valor * (taxaPct / 100);
  return { quantidade: (valor - taxa) / preco, precoMedio: preco, custo: valor, taxa, idExchange: null };
}

export function simularVenda(quantidade: number, preco: number, taxaPct: number): Execucao {
  if (!(preco > 0)) throw new Error('sem preço para simular a venda');
  const bruto = quantidade * preco;
  return { quantidade, precoMedio: preco, custo: bruto, taxa: bruto * (taxaPct / 100), idExchange: null };
}
