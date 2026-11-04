// Ganho e perda das operações fechadas, a partir das ordens executadas (função pura, testada).
// Por estratégia, em ordem de tempo, com preço médio: a compra soma quantidade e custo; a venda tira a
// parte proporcional do custo e o resultado é o que entrou (líquido de taxa) menos esse custo.

export interface OrdemExecutada {
  estrategia_id: number;
  conta_id?: number;
  estrategia: string;
  simbolo: string;
  lado: 'compra' | 'venda';
  modo: 'simulacao' | 'real';
  quantidade: number;
  custo: number;
  taxa: number;
  criada_em: Date | string;
}

export interface Operacao {
  conta_id: number | null;
  estrategia: string;
  simbolo: string;
  moeda: string;
  modo: 'simulacao' | 'real';
  fechada_em: string;
  custo: number;
  resultado: number;
  resultado_pct: number;
}

const EPS = 1e-12;
const moedaDe = (simbolo: string) => (simbolo.split('/')[1] ?? '').split(':')[0] ?? '';

export function operacoesFechadas(ordens: OrdemExecutada[]): Operacao[] {
  const posicoes = new Map<string, { quantidade: number; custo: number }>();
  const ops: Operacao[] = [];
  const emOrdem = [...ordens].sort((a, b) => new Date(a.criada_em).getTime() - new Date(b.criada_em).getTime());
  for (const o of emOrdem) {
    // a posição é por estratégia e par (a varredura troca de par, mas só sem posição)
    const chave = `${o.estrategia_id}|${o.simbolo}|${o.modo}`;
    const p = posicoes.get(chave) ?? { quantidade: 0, custo: 0 };
    const q = Number(o.quantidade);
    const custo = Number(o.custo);
    if (o.lado === 'compra') {
      p.quantidade += q;
      p.custo += custo;
    } else if (p.quantidade > EPS) {
      const vendida = Math.min(q, p.quantidade);
      const base = p.custo * (vendida / p.quantidade);
      const resultado = custo - Number(o.taxa) - base;
      ops.push({
        conta_id: o.conta_id ?? null,
        estrategia: o.estrategia,
        simbolo: o.simbolo,
        moeda: moedaDe(o.simbolo),
        modo: o.modo,
        fechada_em: new Date(o.criada_em).toISOString(),
        custo: base,
        resultado,
        resultado_pct: base > 0 ? (resultado / base) * 100 : 0,
      });
      p.quantidade -= vendida;
      p.custo -= base;
      if (p.quantidade <= EPS) {
        p.quantidade = 0;
        p.custo = 0;
      }
    }
    posicoes.set(chave, p);
  }
  return ops;
}

const diaEm = (iso: string, fuso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** Resultado por dia (últimos `dias`, no fuso) e acumulado, de uma lista de operações de uma moeda. */
export function porDia(ops: Operacao[], agora: Date, fuso: string, dias = 30) {
  const hoje = diaEm(agora.toISOString(), fuso);
  const lista: { dia: string; resultado: number; operacoes: number; acumulado: number }[] = [];
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(`${hoje}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    lista.push({ dia: d.toISOString().slice(0, 10), resultado: 0, operacoes: 0, acumulado: 0 });
  }
  const indice = new Map(lista.map((x, i) => [x.dia, i]));
  let antes = 0; // resultado acumulado de antes da janela
  for (const o of ops) {
    const i = indice.get(diaEm(o.fechada_em, fuso));
    if (i === undefined) {
      if (diaEm(o.fechada_em, fuso) < lista[0]!.dia) antes += o.resultado;
      continue;
    }
    lista[i]!.resultado += o.resultado;
    lista[i]!.operacoes += 1;
  }
  let acc = antes;
  for (const x of lista) {
    acc += x.resultado;
    x.acumulado = acc;
  }
  return lista;
}

/** Os números do cartão: total, hoje, ganhas, perdidas, acerto, maior ganho e maior perda. */
export function resumoDoResultado(ops: Operacao[], agora: Date, fuso: string) {
  const hoje = diaEm(agora.toISOString(), fuso);
  const ganhas = ops.filter((o) => o.resultado > 0);
  const perdidas = ops.filter((o) => o.resultado < 0);
  return {
    total: ops.reduce((t, o) => t + o.resultado, 0),
    hoje: ops.filter((o) => diaEm(o.fechada_em, fuso) === hoje).reduce((t, o) => t + o.resultado, 0),
    operacoes: ops.length,
    ganhas: ganhas.length,
    perdidas: perdidas.length,
    acerto_pct: ops.length ? (ganhas.length / ops.length) * 100 : null,
    maior_ganho: ganhas.length ? Math.max(...ganhas.map((o) => o.resultado)) : 0,
    maior_perda: perdidas.length ? Math.min(...perdidas.map((o) => o.resultado)) : 0,
  };
}

/**
 * O saldo de uma conta a partir do que o dono colocou: capital + resultado das operações fechadas +
 * o que está em aberto agora (valor de mercado das posições menos o custo). Por dia, o saldo do fim
 * do dia pelas operações fechadas; o último ponto soma o aberto.
 */
export function saldoDaConta(capital: number, ops: Operacao[], emAberto: number, agora: Date, fuso: string, dias = 30) {
  const serie = porDia(ops, agora, fuso, dias).map((d) => ({ dia: d.dia, saldo: capital + d.acumulado }));
  const realizado = ops.reduce((t, o) => t + o.resultado, 0);
  const saldo = capital + realizado + emAberto;
  if (serie.length) serie[serie.length - 1]!.saldo = saldo;
  return { capital, realizado, em_aberto: emAberto, saldo, variacao: saldo - capital, variacao_pct: capital > 0 ? ((saldo - capital) / capital) * 100 : null, serie };
}
