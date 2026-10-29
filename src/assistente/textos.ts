// Textos e leitura das respostas do assistente (funções puras, sem rede nem banco).

/** Compra sem resposta expira (o preço anda); aviso de venda fica até a resposta. */
export const COMPRA_EXPIRA_MIN = 30;

export const reais = (v: number) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const codigo = (simbolo: string) => simbolo.split('/')[0]!;

export interface DadosAviso {
  lado: 'compra' | 'venda';
  simbolo: string;
  quantidade: number;
  preco_ref: number;
  stop: number | null;
  alvo: number | null;
  motivo: string | null;
}

export function textoDoAlerta(a: DadosAviso): string {
  const q = Number(a.quantidade);
  const acao = `${q} ${q === 1 ? 'ação' : 'ações'} de ${codigo(a.simbolo)}`;
  if (a.lado === 'compra') {
    return [
      `🟢 COMPRAR ${acao}`,
      `Preço de referência: ${reais(a.preco_ref)} (cotação com até 15 min de atraso)`,
      a.motivo ? `Por quê: ${a.motivo}` : null,
      '',
      'Depois de comprar na XP, registre lá:',
      a.stop ? `• ordem STOP de venda em ${reais(a.stop)}` : null,
      a.alvo ? `• e, se a plataforma deixar, o alvo de venda em ${reais(a.alvo)}` : null,
      '',
      `Este aviso vale por ${COMPRA_EXPIRA_MIN} min. Responda nos botões abaixo.`,
    ].filter((l) => l !== null).join('\n');
  }
  return [
    `🔴 VENDER ${acao}`,
    `Preço de referência: ${reais(a.preco_ref)}`,
    a.motivo ? `Por quê: ${a.motivo}` : null,
    '',
    'Se o stop que você registrou na XP já vendeu, toque em "Já vendi" e informe o preço.',
  ].filter((l) => l !== null).join('\n');
}

/** Lê a resposta "preço quantidade" (ex.: "38,10 1", "38.1", "R$ 38,10 2 ações"). */
export function lerResposta(texto: string): { preco: number; quantidade?: number } | null {
  const numeros = (texto.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(',', '.')));
  const preco = numeros[0];
  if (!preco || !(preco > 0)) return null;
  const quantidade = numeros[1];
  return quantidade && Number.isInteger(quantidade) && quantidade > 0 ? { preco, quantidade } : { preco };
}
