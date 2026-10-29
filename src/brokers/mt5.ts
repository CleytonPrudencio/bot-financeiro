import { query, umOuNada } from '../db.js';
import { logger } from '../logger.js';
import type { Corretora, Execucao } from './tipos.js';
import type { TempoVela } from './ccxt.js';

// Ações da B3 pela ponte MetaTrader 5 (public/ponte-mt5/ponte.py, no Windows do dono). A ponte liga
// para o bot (POST /ponte/sincronizar): manda cotações, velas e o saldo, e leva as ordens pendentes.
// Aqui ficam a leitura desse mercado e a "corretora" que deixa a ordem na fila e espera a resposta.
//
// No bot, cada ação é um par em reais: PETR4/BRL. A ponte usa o código puro (PETR4).

export const MT5 = 'mt5';
/** Cotação mais velha que isto: a ponte (ou o MetaTrader) parou. */
const COTACAO_VALIDA_MS = 3 * 60_000;
/** Tempo para a ponte pegar a ordem; depois disso ela expira e não é mais executada. */
export const ORDEM_EXPIRA_S = 30;
/** Tempo para a ponte responder uma ordem que ela já pegou. */
const RESPOSTA_MS = 60_000;

export const paraBot = (codigo: string) => `${codigo.toUpperCase()}/BRL`;
export const paraMt5 = (simbolo: string) => simbolo.split('/')[0]!.toUpperCase();

interface LinhaMercado {
  simbolo: string;
  cotacao: number | null;
  volume_financeiro: number | null;
  velas: Partial<Record<TempoVela, number[][]>>;
  atualizado_em: Date;
}

export async function cotacaoMt5(simbolo: string): Promise<number> {
  const l = await umOuNada<LinhaMercado>('select * from mt5_mercado where simbolo = $1', [simbolo]);
  if (!l?.cotacao) throw new Error(`sem cotação de ${simbolo} pela ponte MT5 (o programa da ponte e o MetaTrader estão abertos?)`);
  if (Date.now() - new Date(l.atualizado_em).getTime() > COTACAO_VALIDA_MS) {
    throw new Error(`a cotação de ${simbolo} pela ponte MT5 está parada há mais de 3 min`);
  }
  return Number(l.cotacao);
}

export async function velasMt5(simbolo: string, tempo: TempoVela, limite = 400) {
  const l = await umOuNada<LinhaMercado>('select velas from mt5_mercado where simbolo = $1', [simbolo]);
  const linhas = l?.velas?.[tempo];
  if (!linhas?.length) throw new Error(`a ponte MT5 ainda não mandou velas de ${tempo} de ${simbolo}`);
  return linhas.slice(-limite).map((v) => ({ t: v[0]!, abre: v[1]!, max: v[2]!, min: v[3]!, fecha: v[4]!, volume: v[5] ?? 0 }));
}

/** Ações do universo que a ponte está mandando, da mais negociada para a menos. */
export async function paresMt5(volumeMin: number) {
  const linhas = await query<LinhaMercado>(
    `select simbolo, cotacao, volume_financeiro from mt5_mercado where atualizado_em > now() - interval '10 minutes'`,
  );
  return linhas
    .map((l) => ({ simbolo: l.simbolo, volume: Number(l.volume_financeiro ?? 0), preco: l.cotacao === null ? null : Number(l.cotacao), variacao_pct: null }))
    // volume 0 = a corretora não informou o giro: não dá para filtrar por ele
    .filter((p) => p.volume === 0 || p.volume >= volumeMin)
    .sort((a, b) => b.volume - a.volume);
}

/** As ações que a ponte deve acompanhar: o universo configurado e os pares das estratégias MT5. */
export async function observarMt5(): Promise<{ simbolos: string[]; tempos: TempoVela[] }> {
  const [cfg] = await query<{ valor: string[] }>(`select valor from configuracoes where chave = 'mt5_universo'`);
  const estrategias = await query<{ simbolo: string; auto_tempo: TempoVela }>(
    `select e.simbolo, e.auto_tempo from estrategias e join contas c on c.id = e.conta_id where c.exchange = $1`,
    [MT5],
  );
  const simbolos = new Set((cfg?.valor ?? []).map((s) => s.toUpperCase()));
  for (const e of estrategias) simbolos.add(paraMt5(e.simbolo));
  const tempos = new Set<TempoVela>(['15m', '1d', ...estrategias.map((e) => e.auto_tempo)]);
  return { simbolos: [...simbolos], tempos: [...tempos] };
}

// ------------------------------------------------------------------ a corretora

export interface ResultadoOrdem {
  ok: boolean;
  preco?: number;
  quantidade?: number;
  id_exchange?: string | null;
  erro?: string;
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CorretoraMt5 implements Corretora {
  constructor(private contaId: number) {}

  cotacao(simbolo: string): Promise<number> {
    return cotacaoMt5(simbolo);
  }

  /** Na B3 se compra ação inteira: o valor vira a maior quantidade que ele paga (lote fracionário abaixo de 100). */
  async comprar(simbolo: string, valor: number, precoRef: number): Promise<Execucao> {
    const quantidade = Math.floor(valor / precoRef);
    if (quantidade < 1) throw new Error(`R$ ${valor} não compra nem 1 ação de ${paraMt5(simbolo)} a R$ ${precoRef}`);
    return this.enviar({ lado: 'compra', simbolo, quantidade, preco_ref: precoRef });
  }

  async vender(simbolo: string, quantidade: number, precoRef: number): Promise<Execucao> {
    const inteira = Math.floor(quantidade + 1e-9);
    if (inteira < 1) throw new Error(`quantidade de ${paraMt5(simbolo)} para vender é menor que 1 ação`);
    return this.enviar({ lado: 'venda', simbolo, quantidade: inteira, preco_ref: precoRef });
  }

  async saldos(): Promise<Record<string, number>> {
    const c = await umOuNada<{ ponte_info: { saldo_livre?: number; posicoes?: Record<string, number> } | null; ponte_visto_em: Date | null }>(
      'select ponte_info, ponte_visto_em from contas where id = $1',
      [this.contaId],
    );
    if (!c?.ponte_visto_em) throw new Error('a ponte MT5 desta conta ainda não se conectou');
    if (Date.now() - new Date(c.ponte_visto_em).getTime() > COTACAO_VALIDA_MS) throw new Error('a ponte MT5 desta conta está desconectada há mais de 3 min');
    const saldos: Record<string, number> = {};
    if (c.ponte_info?.saldo_livre) saldos.BRL = c.ponte_info.saldo_livre;
    for (const [codigo, qtd] of Object.entries(c.ponte_info?.posicoes ?? {})) if (qtd > 0) saldos[codigo] = qtd;
    return saldos;
  }

  /**
   * Deixa a ordem na fila da ponte e espera o resultado. Se a ponte não pegar em 30 s, a ordem
   * expira (e a ponte não a executa mais); se pegar e não responder em 60 s, é erro para conferir.
   */
  private async enviar(dados: { lado: 'compra' | 'venda'; simbolo: string; quantidade: number; preco_ref: number }): Promise<Execucao> {
    const [cmd] = await query<{ id: number }>('insert into mt5_comandos (conta_id, dados) values ($1, $2) returning id', [this.contaId, JSON.stringify(dados)]);
    const id = cmd!.id;
    const inicio = Date.now();
    for (;;) {
      await esperar(300);
      const [c] = await query<{ situacao: string; resultado: ResultadoOrdem | null; enviado_em: Date | null }>(
        'select situacao, resultado, enviado_em from mt5_comandos where id = $1',
        [id],
      );
      if (!c) throw new Error('ordem sumiu da fila da ponte');
      if (c.situacao === 'feito' && c.resultado?.ok) {
        const r = c.resultado;
        const quantidade = Number(r.quantidade ?? 0);
        const preco = Number(r.preco ?? dados.preco_ref);
        return { quantidade, precoMedio: preco, custo: quantidade * preco, taxa: 0, idExchange: r.id_exchange ?? null };
      }
      if (c.situacao === 'erro' || c.situacao === 'feito') throw new Error(`MT5: ${c.resultado?.erro ?? 'a corretora recusou a ordem'}`.slice(0, 300));
      if (c.situacao === 'expirado') throw new Error(`a ponte MT5 não pegou a ordem em ${ORDEM_EXPIRA_S} s (o programa da ponte está rodando?)`);
      if (c.situacao === 'pendente' && Date.now() - inicio > ORDEM_EXPIRA_S * 1000) {
        const exp = await query(`update mt5_comandos set situacao = 'expirado', terminado_em = now() where id = $1 and situacao = 'pendente' returning id`, [id]);
        if (exp.length) throw new Error(`a ponte MT5 não pegou a ordem em ${ORDEM_EXPIRA_S} s (o programa da ponte está rodando?)`);
      }
      if (c.situacao === 'enviado' && c.enviado_em && Date.now() - new Date(c.enviado_em).getTime() > RESPOSTA_MS) {
        logger.error({ comando: id, ...dados }, 'ponte MT5 pegou a ordem e não respondeu');
        throw new Error('a ponte MT5 pegou a ordem e não respondeu em 60 s: confira no MetaTrader se ela foi executada');
      }
    }
  }
}
