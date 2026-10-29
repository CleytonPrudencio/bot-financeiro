import { mesmoSimbolo, type Sinal } from './sinal.js';

// Toda ordem passa por aqui antes de chegar na exchange. É uma função pura: recebe o sinal e o
// estado atual e devolve se a ordem sai, em que modo e de quanto. Os testes cobrem cada regra.
//
// Dinheiro real só quando as TRÊS chaves estão ligadas: BOT_LIVE_ENABLED no servidor, a conta em
// modo "real" e a estratégia marcada como "real". Se a estratégia pede real e falta alguma das
// outras, o sinal é rejeitado (nunca cai em simulação calado, para ninguém achar que operou).

export interface EstadoRisco {
  paradaGeral: boolean;
  realNoServidor: boolean;
  conta: { modo: 'simulacao' | 'real' };
  estrategia: {
    ativa: boolean;
    real: boolean;
    simbolo: string;
    valor_ordem: number;
    limite_por_ordem: number;
    limite_diario: number;
    limite_posicao: number | null;
    intervalo_min_seg: number;
    desvio_max_pct: number;
    ips_permitidos: string | null;
  };
  /** soma do custo das compras executadas hoje (fuso de São Paulo) */
  gastoHoje: number;
  ultimaOrdemEm: Date | null;
  posicao: { quantidade: number; custo_total: number };
  /** cotação atual do par; null se não deu para consultar */
  cotacao: number | null;
  agora: Date;
  ip: string | null;
}

export type Decisao =
  | { aprovado: true; modo: 'simulacao' | 'real'; lado: 'compra'; valor: number }
  | { aprovado: true; modo: 'simulacao' | 'real'; lado: 'venda'; quantidade: number }
  | { aprovado: false; situacao: 'rejeitado' | 'ignorado'; motivo: string };

const nao = (motivo: string, situacao: 'rejeitado' | 'ignorado' = 'rejeitado'): Decisao => ({
  aprovado: false,
  situacao,
  motivo,
});

export function ipPermitido(ip: string | null, lista: string | null): boolean {
  const permitidos = (lista ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (permitidos.length === 0) return true;
  return ip !== null && permitidos.includes(ip.replace(/^::ffff:/, ''));
}

export function avaliar(sinal: Sinal, e: EstadoRisco): Decisao {
  const est = e.estrategia;

  if (e.paradaGeral) return nao('parada geral ligada: nenhuma ordem sai');
  if (!est.ativa) return nao('estratégia desativada');
  if (!ipPermitido(e.ip, est.ips_permitidos)) return nao(`IP ${e.ip ?? '?'} fora da lista permitida`);
  if (sinal.simbolo && !mesmoSimbolo(sinal.simbolo, est.simbolo)) {
    return nao(`par do sinal (${sinal.simbolo}) diferente do da estratégia (${est.simbolo})`);
  }

  let modo: 'simulacao' | 'real' = 'simulacao';
  if (est.real) {
    if (!e.realNoServidor) return nao('estratégia em modo real, mas o dinheiro real está desligado no servidor (BOT_LIVE_ENABLED)');
    if (e.conta.modo !== 'real') return nao('estratégia em modo real, mas a conta está em simulação');
    modo = 'real';
  }

  if (e.ultimaOrdemEm && sinal.acao !== 'zerar') {
    const passou = (e.agora.getTime() - e.ultimaOrdemEm.getTime()) / 1000;
    if (passou < est.intervalo_min_seg) {
      return nao(`intervalo mínimo entre ordens: faltam ${Math.ceil(est.intervalo_min_seg - passou)} s`);
    }
  }

  if (sinal.preco !== undefined && e.cotacao !== null) {
    const desvio = (Math.abs(sinal.preco - e.cotacao) / e.cotacao) * 100;
    if (desvio > est.desvio_max_pct) {
      return nao(`preço do sinal (${sinal.preco}) está ${desvio.toFixed(2)}% longe da cotação (${e.cotacao}); máximo ${est.desvio_max_pct}%`);
    }
  }

  if (sinal.acao === 'comprar') {
    const valor = sinal.valor ?? est.valor_ordem;
    if (valor > est.limite_por_ordem) return nao(`valor ${valor} acima do limite por ordem (${est.limite_por_ordem})`);
    if (e.gastoHoje + valor > est.limite_diario) {
      return nao(`limite diário: já comprou ${e.gastoHoje} hoje, mais ${valor} passa de ${est.limite_diario}`);
    }
    if (est.limite_posicao !== null && e.posicao.custo_total + valor > est.limite_posicao) {
      return nao(`limite de posição: posição de ${e.posicao.custo_total} mais ${valor} passa de ${est.limite_posicao}`);
    }
    return { aprovado: true, modo, lado: 'compra', valor };
  }

  // vender e zerar: só o que a estratégia comprou (à vista, sem venda a descoberto)
  if (e.posicao.quantidade <= 0) return nao('sem posição aberta para vender', 'ignorado');
  const quantidade =
    sinal.acao === 'vender' && sinal.quantidade !== undefined
      ? Math.min(sinal.quantidade, e.posicao.quantidade)
      : e.posicao.quantidade;
  return { aprovado: true, modo, lado: 'venda', quantidade };
}

// ------------------------------------------------------------------ parecer das IAs
//
// Roda DEPOIS de `avaliar` aprovar. A IA só pode barrar: nunca cria ordem, nunca muda valor ou
// lado, nunca passa por cima de limite. Se a estratégia exige IA e não há IA para consultar, a
// ordem não sai (falha fechada).

export interface PoliticaIa {
  modo: 'desligado' | 'consultivo' | 'obrigatorio';
  /** aprovações necessárias; null = todas as IAs consultadas */
  quorum: number | null;
  /** IA que falhou: "reprova" conta como não aprovou; "ignora" sai da conta */
  falha: 'reprova' | 'ignora';
  /** aprovação abaixo desta confiança não conta */
  confiancaMin: number;
  nasVendas: boolean;
}

export type VotoIa = { ok: true; decisao: 'aprovar' | 'vetar'; confianca: number } | { ok: false };

/** Se este sinal passa pelas IAs. "zerar" nunca passa: sair de uma posição não depende de IA. */
export function consultaIa(acao: Sinal['acao'], p: PoliticaIa): boolean {
  if (p.modo === 'desligado') return false;
  if (acao === 'comprar') return true;
  return acao === 'vender' && p.nasVendas;
}

export function decidirComIa(votos: VotoIa[], p: PoliticaIa): { aprovado: boolean; motivo: string } {
  const validos = votos.filter((v): v is Extract<VotoIa, { ok: true }> => v.ok);
  const falhas = votos.length - validos.length;
  const aprovacoes = validos.filter((v) => v.decisao === 'aprovar' && v.confianca >= p.confiancaMin).length;
  const vetos = validos.filter((v) => v.decisao === 'vetar').length;
  const placar = `${aprovacoes} aprovaram, ${vetos} vetaram${falhas ? `, ${falhas} falharam` : ''}`;

  if (p.modo !== 'obrigatorio') return { aprovado: true, motivo: `IA consultiva (${placar})` };
  if (votos.length === 0) return { aprovado: false, motivo: 'IA obrigatória, mas nenhum conector de IA ativo para consultar' };

  const consideradas = p.falha === 'ignora' ? validos.length : votos.length;
  if (consideradas === 0) return { aprovado: true, motivo: `nenhuma IA respondeu e a estratégia ignora falhas (${placar})` };
  const precisa = Math.min(p.quorum ?? consideradas, consideradas);
  if (aprovacoes >= precisa) return { aprovado: true, motivo: `IA aprovou: ${placar}; precisava de ${precisa}` };
  return {
    aprovado: false,
    motivo: `IA barrou: ${placar}; precisava de ${precisa} aprovação(ões) com confiança ≥ ${Math.round(p.confiancaMin * 100)}%`,
  };
}

// ------------------------------------------------------------------ análise dos 5 agentes
//
// Trava opcional da estratégia: só COMPRA se houver uma análise pronta e recente do par com nota
// mínima. Como a IA, só barra; venda e zerar nunca dependem dela.

export interface AnaliseRecente {
  nota: number;
  terminada_em: Date;
}

export function conferirAnalise(
  acao: Sinal['acao'],
  analise: AnaliseRecente | null,
  e: { analise_nota_min: number | null; analise_validade_h: number },
  agora: Date,
): { ok: true } | { ok: false; motivo: string } {
  if (acao !== 'comprar' || e.analise_nota_min === null) return { ok: true };
  if (!analise) return { ok: false, motivo: `exige análise com nota ≥ ${e.analise_nota_min}, e não há análise pronta deste par` };
  const horas = (agora.getTime() - analise.terminada_em.getTime()) / 3_600_000;
  if (horas > e.analise_validade_h) {
    return { ok: false, motivo: `a última análise do par tem ${Math.floor(horas)} h; a estratégia aceita até ${e.analise_validade_h} h` };
  }
  if (analise.nota < e.analise_nota_min) return { ok: false, motivo: `nota da análise ${analise.nota} abaixo do mínimo ${e.analise_nota_min}` };
  return { ok: true };
}

// ------------------------------------------------------------------ saída do piloto automático
//
// Confere, a cada cotação, se a posição aberta tem de ser zerada. Sair nunca depende de IA.
// - stop: o preço caiu `stopPct` abaixo do preço médio de compra (perda máxima da operação);
// - alvo: subiu `alvoPct` acima do preço médio (realiza o ganho);
// - proteção: depois que o ganho chegou a `protecaoPct`, um recuo de `recuoPct` desde o maior
//   preço fecha a posição, e nunca abaixo do preço médio mais as taxas (`PISO_PROTECAO`).

export interface RegrasSaida {
  stopPct: number;
  alvoPct: number;
  protecaoPct: number;
  recuoPct: number;
}

/** Ganho mínimo que a proteção garante: cobre as duas taxas (0,1% cada na Binance) com folga. */
export const PISO_PROTECAO = 1.004;

export type Saida = { sair: false } | { sair: true; tipo: 'stop' | 'alvo' | 'protecao'; motivo: string };

export function conferirSaida(precoMedio: number, preco: number, maiorPreco: number, r: RegrasSaida): Saida {
  if (!(precoMedio > 0) || !(preco > 0)) return { sair: false };
  const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const variacao = (preco / precoMedio - 1) * 100;
  const stop = precoMedio * (1 - r.stopPct / 100);
  if (preco <= stop) return { sair: true, tipo: 'stop', motivo: `stop de perda: ${pct(variacao)} desde a compra (limite -${r.stopPct}%)` };
  if (preco >= precoMedio * (1 + r.alvoPct / 100)) return { sair: true, tipo: 'alvo', motivo: `alvo de ganho: ${pct(variacao)} desde a compra` };
  const maior = Math.max(maiorPreco, preco);
  if (maior >= precoMedio * (1 + r.protecaoPct / 100)) {
    const gatilho = Math.max(maior * (1 - r.recuoPct / 100), precoMedio * PISO_PROTECAO);
    if (preco <= gatilho) {
      return { sair: true, tipo: 'protecao', motivo: `proteção do ganho: chegou a ${pct((maior / precoMedio - 1) * 100)} e recuou; sai com ${pct(variacao)}` };
    }
  }
  return { sair: false };
}

/**
 * O stop que a posição deve ter agora (o mesmo nível em que `conferirSaida` manda sair): o stop de
 * perda até o ganho chegar a `protecaoPct`; depois, o recuo desde o maior preço, nunca abaixo do
 * preço médio mais as taxas. O assistente manda o dono registrar este valor na corretora.
 */
export function stopSugerido(precoMedio: number, maiorPreco: number, r: RegrasSaida): number {
  const inicial = precoMedio * (1 - r.stopPct / 100);
  if (!(maiorPreco >= precoMedio * (1 + r.protecaoPct / 100))) return inicial;
  return Math.max(maiorPreco * (1 - r.recuoPct / 100), precoMedio * PISO_PROTECAO);
}

/** Vale avisar o dono para subir o stop? Só quando ele sobe pelo menos `passoPct` (0,5%) sobre o último aviso. */
export function deveAvisarStop(novo: number, ultimoAvisado: number | null, passoPct = 0.5): boolean {
  if (ultimoAvisado === null) return false; // o primeiro stop vai no aviso de compra
  return novo > ultimoAvisado * (1 + passoPct / 100);
}
