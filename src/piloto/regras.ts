import { ifr, macd, mediaSimples, type Vela } from '../analise/indicadores.js';

// Regras do piloto automático, em funções puras (os testes cobrem cada uma). O piloto só olha velas
// diárias JÁ FECHADAS: a vela de hoje ainda muda e daria sinal falso.
//
// Entrada (seguir a tendência, sem tentar pegar faca caindo):
//   - tendência longa de alta: fechamento acima da média de 200 dias e média de 50 acima da de 200;
//   - momento a favor: fechamento acima da média de 20 e histograma do MACD positivo;
//   - sem esticar: IFR entre 40 e 70.
// O sinal sai só na VIRADA (a vela de ontem não cumpria tudo, a de hoje cumpre): assim o agente de IA
// é consultado poucas vezes por mês, e não todo dia enquanto a condição dura.

export const DIA_MS = 86_400_000;

/** Tira a vela que ainda está aberta (a de hoje, na Binance começa às 00:00 UTC). */
export function velasFechadas(velas: Vela[], agora: number): Vela[] {
  return velas.filter((v) => v.t + DIA_MS <= agora);
}

export interface Leitura {
  fechamento: number;
  media20: number;
  media50: number;
  media200: number;
  ifr: number;
  histograma: number;
}

export function ler(fechamentos: number[]): Leitura | null {
  const media20 = mediaSimples(fechamentos, 20);
  const media50 = mediaSimples(fechamentos, 50);
  const media200 = mediaSimples(fechamentos, 200);
  const i = ifr(fechamentos);
  const m = macd(fechamentos);
  const fechamento = fechamentos[fechamentos.length - 1];
  if (fechamento === undefined || media20 === null || media50 === null || media200 === null || i === null || !m) return null;
  return { fechamento, media20, media50, media200, ifr: i, histograma: m.histograma };
}

/** O que falta para a entrada (vazio = cumpre tudo). */
export function faltas(l: Leitura): string[] {
  const f: string[] = [];
  if (l.fechamento <= l.media200) f.push('preço abaixo da média de 200 dias');
  if (l.media50 <= l.media200) f.push('média de 50 abaixo da de 200');
  if (l.fechamento <= l.media20) f.push('preço abaixo da média de 20 dias');
  if (l.histograma <= 0) f.push('MACD sem força (histograma negativo)');
  if (l.ifr < 40) f.push(`IFR fraco (${l.ifr.toFixed(0)})`);
  if (l.ifr > 70) f.push(`IFR esticado (${l.ifr.toFixed(0)})`);
  return f;
}

export type Entrada = { comprar: true; motivo: string } | { comprar: false; motivo: string };

/** Avalia a última vela fechada contra a anterior. Precisa de 201 velas fechadas, no mínimo. */
export function avaliarEntrada(fechadas: Vela[]): Entrada {
  const fechamentos = fechadas.map((v) => v.fecha);
  if (fechamentos.length < 201) return { comprar: false, motivo: `poucas velas para a média de 200 dias (${fechamentos.length})` };
  const hoje = ler(fechamentos);
  const ontem = ler(fechamentos.slice(0, -1));
  if (!hoje || !ontem) return { comprar: false, motivo: 'indicadores indisponíveis' };
  const falta = faltas(hoje);
  if (falta.length) return { comprar: false, motivo: `sem entrada: ${falta.join('; ')}` };
  if (!faltas(ontem).length) return { comprar: false, motivo: 'tendência a favor, mas já estava assim ontem: espera a próxima virada' };
  return {
    comprar: true,
    motivo: `virada para alta: preço acima das médias de 20 e 200 dias, MACD positivo, IFR ${hoje.ifr.toFixed(0)}`,
  };
}

/** Saída por tendência: fechamento abaixo da média de 50 dias desfaz o motivo da compra. */
export function tendenciaQuebrou(fechadas: Vela[]): string | null {
  const fechamentos = fechadas.map((v) => v.fecha);
  const media50 = mediaSimples(fechamentos, 50);
  const ultimo = fechamentos[fechamentos.length - 1];
  if (media50 === null || ultimo === undefined) return null;
  return ultimo < media50 ? 'tendência quebrou: fechamento abaixo da média de 50 dias' : null;
}

/** Corte prévio pelo Kronos, para não gastar IA à toa: abaixo de 50% de chance de alta, não entra. */
export const KRONOS_MIN_ALTA = 0.5;
