// Como os robôs decidem, em funções puras (sem desenho), para dar para testar e depois trocar pela
// estratégia de verdade. O analista propõe; o chefe confere de novo com outro olhar; os dois juntam
// as notas e decidem.

import { ifr, media, volatilidade } from './mercado.js';

export const VALOR_POR_ORDEM = 1000; // em moeda de cotação de cada ativo
export const MAX_POSICOES_ABERTAS = 3; // no escritório inteiro
export const NOTA_MINIMA = 0.6;

export function novaCarteira() {
  return { quantidade: 0, precoEntrada: 0, resultado: 0, perdasSeguidas: 0, aprovadas: 0, reprovadas: 0, operacoes: 0 };
}

const tanh = (x) => Math.tanh(x);
const limitar = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * O analista olha o próprio ativo e devolve uma proposta ou null.
 * Compra no cruzamento para cima da média curta (9) sobre a longa (26), se o IFR não estiver
 * esticado. Vende no cruzamento para baixo, no stop ou no alvo.
 */
export function analisar(ativo, carteira) {
  const h = ativo.historico;
  if (h.length < 70) return null;
  const anterior = h.slice(0, -1);
  const curta = media(h, 9);
  const longa = media(h, 26);
  const curtaAntes = media(anterior, 9);
  const longaAntes = media(anterior, 26);
  const indice = ifr(h);
  const preco = ativo.preco;
  const distancia = Math.abs(curta - longa) / preco / ativo.sigma;
  const base = {
    ativoId: ativo.id,
    preco,
    indicadores: { curta, longa, ifr: indice },
  };

  if (carteira.quantidade <= 0) {
    const cruzouParaCima = curtaAntes <= longaAntes && curta > longa;
    if (cruzouParaCima && indice < 72) {
      return {
        ...base,
        lado: 'compra',
        motivo: 'média curta cruzou a longa para cima',
        confianca: limitar(0.5 + 0.42 * tanh(distancia / 1.5) + (indice < 55 ? 0.05 : 0), 0, 0.97),
      };
    }
    return null;
  }

  const lucro = preco / carteira.precoEntrada - 1;
  const stop = -ativo.volDia * 0.55;
  const alvo = ativo.volDia * 1.1;
  if (lucro <= stop) return { ...base, lado: 'venda', motivo: `stop: ${(lucro * 100).toFixed(2)}%`, urgente: true, confianca: 0.92 };
  if (lucro >= alvo) return { ...base, lado: 'venda', motivo: `alvo: +${(lucro * 100).toFixed(2)}%`, urgente: true, confianca: 0.9 };
  if (curtaAntes >= longaAntes && curta < longa) {
    return {
      ...base,
      lado: 'venda',
      motivo: 'média curta cruzou a longa para baixo',
      confianca: limitar(0.5 + 0.4 * tanh(distancia / 1.5), 0, 0.95),
    };
  }
  return null;
}

/**
 * O chefe confere de novo, com um olhar mais longo e sobre o escritório inteiro.
 * Cada item tem peso; "veto" reprova sozinho.
 */
export function verificarChefe(proposta, ativo, carteira, posicoesAbertas) {
  const h = ativo.historico;
  const tendencia = media(h, 60);
  const indice = ifr(h);
  const vol = volatilidade(h, 30) ?? ativo.sigma;
  const itens = [];

  if (proposta.lado === 'compra') {
    itens.push({ texto: 'Tendência longa (média 60) a favor', ok: ativo.preco > tendencia, peso: 3 });
    itens.push({ texto: `IFR sem exagero (${indice.toFixed(0)})`, ok: indice < 68, peso: 2 });
    itens.push({ texto: 'Volatilidade sob controle', ok: vol < ativo.sigma * 1.7, peso: 2 });
    itens.push({ texto: 'Sem sequência de perdas', ok: carteira.perdasSeguidas < 2, peso: 2 });
    itens.push({
      texto: `Exposição: ${posicoesAbertas}/${MAX_POSICOES_ABERTAS} posições`,
      ok: posicoesAbertas < MAX_POSICOES_ABERTAS,
      peso: 1,
      veto: posicoesAbertas >= MAX_POSICOES_ABERTAS,
    });
  } else if (proposta.urgente) {
    itens.push({ texto: 'Proteger o resultado tem prioridade', ok: true, peso: 3 });
    itens.push({ texto: 'Posição aberta confere', ok: carteira.quantidade > 0, peso: 2, veto: carteira.quantidade <= 0 });
  } else {
    itens.push({ texto: 'Tendência longa virou para baixo', ok: ativo.preco < tendencia, peso: 3 });
    itens.push({ texto: `IFR sem venda exagerada (${indice.toFixed(0)})`, ok: indice > 32, peso: 2 });
    itens.push({ texto: 'Posição aberta confere', ok: carteira.quantidade > 0, peso: 2, veto: carteira.quantidade <= 0 });
  }

  const total = itens.reduce((s, i) => s + i.peso, 0);
  const nota = itens.reduce((s, i) => s + (i.ok ? i.peso : 0), 0) / total;
  return { itens, nota };
}

/** Os dois juntos: confiança do analista e nota do chefe. Veto do chefe reprova sozinho. */
export function decidirJuntos(proposta, verificacao) {
  const veto = verificacao.itens.find((i) => i.veto);
  const combinada = proposta.confianca * 0.45 + verificacao.nota * 0.55;
  const aprovado = !veto && combinada >= NOTA_MINIMA;
  return {
    aprovado,
    combinada,
    motivo: veto ? `veto: ${veto.texto}` : aprovado ? 'nota conjunta acima do mínimo' : `nota conjunta abaixo de ${Math.round(NOTA_MINIMA * 100)}%`,
  };
}

/**
 * Conselho de IAs (opcional, com IAs de verdade pela API do bot): só pode vetar, e a maioria dos
 * que responderam decide. Stop e alvo (propostas urgentes) não são vetados: sair de posição não
 * depende de IA. Sem respostas, a decisão fica como estava.
 */
export function aplicarConselho(decisao, respostas, podeVetar = true) {
  if (!respostas?.length) return decisao;
  const validas = respostas.filter((r) => r.ok);
  const vetos = validas.filter((r) => r.parecer.decisao === 'vetar').length;
  const conselho = { respostas, vetos, aprovacoes: validas.length - vetos, falhas: respostas.length - validas.length };
  if (podeVetar && decisao.aprovado && vetos > validas.length - vetos) {
    return { ...decisao, aprovado: false, motivo: `conselho de IAs vetou (${vetos} de ${validas.length})`, conselho };
  }
  return { ...decisao, conselho };
}

/** Executa a ordem fictícia na carteira do robô e devolve o resultado da operação (venda). */
export function executar(carteira, lado, preco) {
  if (lado === 'compra') {
    carteira.quantidade = VALOR_POR_ORDEM / preco;
    carteira.precoEntrada = preco;
    carteira.operacoes++;
    return { resultado: 0 };
  }
  const resultado = (preco - carteira.precoEntrada) * carteira.quantidade;
  carteira.resultado += resultado;
  carteira.perdasSeguidas = resultado < 0 ? carteira.perdasSeguidas + 1 : 0;
  carteira.quantidade = 0;
  carteira.precoEntrada = 0;
  carteira.operacoes++;
  return { resultado };
}
