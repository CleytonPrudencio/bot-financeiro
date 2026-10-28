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
