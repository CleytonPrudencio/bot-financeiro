import { ifr, macd, mediaSimples, type Vela } from '../analise/indicadores.js';

// Regras do piloto automático, em funções puras (os testes cobrem cada uma). O piloto só olha velas
// JÁ FECHADAS (de 1 min a 1 dia, conforme a estratégia): a vela aberta ainda muda e daria sinal falso.
//
// Entrada (seguir a tendência, sem tentar pegar faca caindo), contada em velas do tempo escolhido:
//   - tendência longa de alta: fechamento acima da média de 200 velas e média de 50 acima da de 200;
//   - momento a favor: fechamento acima da média de 20 e histograma do MACD positivo;
//   - sem esticar: IFR entre 40 e 70.
// Por padrão o sinal sai só na VIRADA (a vela anterior não cumpria tudo, a última cumpre). Com
// `exigirVirada: false`, também entra numa tendência já em curso (o piloto limita o custo de IA com
// o teto diário e deixa de fora por 6 h o par barrado ou que bateu no stop).
//
// Com velas curtas (1 min a 4 h), vale também o filtro diário: não compra com o preço abaixo da
// média de 50 dias (tendência maior contra).

export const DIA_MS = 86_400_000;

/** Tira a vela que ainda está aberta (na diária da Binance, a de hoje começa às 00:00 UTC). */
export function velasFechadas(velas: Vela[], agora: number, duracaoMs = DIA_MS): Vela[] {
  return velas.filter((v) => v.t + duracaoMs <= agora);
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
  if (l.fechamento <= l.media200) f.push('preço abaixo da média de 200 velas');
  if (l.media50 <= l.media200) f.push('média de 50 abaixo da de 200');
  if (l.fechamento <= l.media20) f.push('preço abaixo da média de 20 velas');
  if (l.histograma <= 0) f.push('MACD sem força (histograma negativo)');
  if (l.ifr < 40) f.push(`IFR fraco (${l.ifr.toFixed(0)})`);
  if (l.ifr > 70) f.push(`IFR esticado (${l.ifr.toFixed(0)})`);
  return f;
}

export type Entrada = { comprar: true; motivo: string } | { comprar: false; motivo: string };

/** Avalia a última vela fechada contra a anterior. Precisa de 201 velas fechadas, no mínimo. */
export function avaliarEntrada(fechadas: Vela[], { exigirVirada = true }: { exigirVirada?: boolean } = {}): Entrada {
  const fechamentos = fechadas.map((v) => v.fecha);
  if (fechamentos.length < 201) return { comprar: false, motivo: `poucas velas para a média de 200 (${fechamentos.length})` };
  const hoje = ler(fechamentos);
  const ontem = ler(fechamentos.slice(0, -1));
  if (!hoje || !ontem) return { comprar: false, motivo: 'indicadores indisponíveis' };
  const falta = faltas(hoje);
  if (falta.length) return { comprar: false, motivo: `sem entrada: ${falta.join('; ')}` };
  const jaEstava = !faltas(ontem).length;
  if (jaEstava && exigirVirada) return { comprar: false, motivo: 'tendência a favor, mas já estava assim na vela anterior: espera a próxima virada' };
  if (jaEstava) {
    return { comprar: true, motivo: `tendência de alta em curso: preço acima das médias de 20 e 200 velas, MACD positivo, IFR ${hoje.ifr.toFixed(0)}` };
  }
  return {
    comprar: true,
    motivo: `virada para alta: preço acima das médias de 20 e 200 velas, MACD positivo, IFR ${hoje.ifr.toFixed(0)}`,
  };
}

/** Filtro diário para velas curtas: null se a tendência maior permite comprar, ou o motivo. */
export function filtroDiario(diarias: Vela[]): string | null {
  const fechamentos = diarias.map((v) => v.fecha);
  const media50 = mediaSimples(fechamentos, 50);
  const ultimo = fechamentos[fechamentos.length - 1];
  if (media50 === null || ultimo === undefined) return 'sem velas diárias para conferir a tendência maior';
  return ultimo > media50 ? null : 'tendência diária contra (preço abaixo da média de 50 dias)';
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

/**
 * Pregão regular da B3 (ações à vista): segunda a sexta, das 10h às 16h55 de Brasília (depois vem o
 * leilão de fechamento). Feriado não entra aqui: nesses dias a corretora recusa a ordem.
 */
export function b3Aberta(agora: number): boolean {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(agora))
      .map((x) => [x.type, x.value]),
  );
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const minutos = Number(p.hour) * 60 + Number(p.minute);
  return minutos >= 10 * 60 && minutos < 16 * 60 + 55;
}
