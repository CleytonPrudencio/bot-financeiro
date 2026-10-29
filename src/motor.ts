import type pg from 'pg';
import { config } from './config.js';
import { derivarChave, decifrar, hashToken } from './crypto.js';
import { transacao, umOuNada } from './db.js';
import { logger } from './logger.js';
import { avaliar, conferirAnalise, consultaIa, decidirComIa, type AnaliseRecente, type EstadoRisco, type PoliticaIa } from './risco.js';
import { consultarIas, type ConectorIa, type RespostaIa } from './ia/index.js';
import { lerSinal, type Sinal } from './sinal.js';
import { CorretoraCcxt, cotacaoPublica } from './brokers/ccxt.js';
import { simularCompra, simularVenda } from './brokers/simulacao.js';
import { moedas, type Execucao } from './brokers/tipos.js';

const chave = derivarChave(config.chaveCifra);
const EPS = 1e-12;

export interface Conta {
  id: number;
  nome: string;
  exchange: string;
  modo: 'simulacao' | 'real';
  testnet: boolean;
  api_key_cifrada: string | null;
  api_secret_cifrada: string | null;
  api_senha_cifrada: string | null;
  taxa_simulada_pct: number;
}

export interface Estrategia {
  id: number;
  nome: string;
  conta_id: number;
  simbolo: string;
  ativa: boolean;
  real: boolean;
  valor_ordem: number;
  limite_por_ordem: number;
  limite_diario: number;
  limite_posicao: number | null;
  intervalo_min_seg: number;
  desvio_max_pct: number;
  ips_permitidos: string | null;
  ia_modo: 'desligado' | 'consultivo' | 'obrigatorio';
  ia_conectores: number[];
  ia_quorum: number | null;
  ia_falha: 'reprova' | 'ignora';
  ia_confianca_min: number;
  ia_nas_vendas: boolean;
  ia_contexto: string | null;
  analise_nota_min: number | null;
  analise_validade_h: number;
}

export function politicaIa(e: Estrategia): PoliticaIa {
  return {
    modo: e.ia_modo,
    quorum: e.ia_quorum,
    falha: e.ia_falha,
    confiancaMin: e.ia_confianca_min,
    nasVendas: e.ia_nas_vendas,
  };
}

/** Conectores que a estratégia consulta: os escolhidos (se ativos) ou, sem escolha, todos os ativos. */
export async function conectoresDa(c: pg.PoolClient, e: Estrategia): Promise<ConectorIa[]> {
  const r = await c.query<ConectorIa>(
    `select * from conectores_ia where ativo and (cardinality($1::bigint[]) = 0 or id = any($1::bigint[])) order by id`,
    [e.ia_conectores ?? []],
  );
  return r.rows;
}

async function gravarPareceres(c: pg.PoolClient, sinalId: number, estrategiaId: number, respostas: RespostaIa[]): Promise<void> {
  for (const r of respostas) {
    await c.query(
      `insert into pareceres_ia (sinal_id, estrategia_id, conector_id, conector_nome, modelo, decisao, confianca, motivo, erro, ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [sinalId, estrategiaId, r.conector_id, r.conector, r.modelo,
        r.ok ? r.parecer.decisao : null, r.ok ? r.parecer.confianca : null, r.ok ? r.parecer.motivo : null, r.ok ? null : r.erro, r.ms],
    );
  }
}

export type Resultado =
  | { status: 404 }
  | { status: 400 | 200 | 502; situacao: string; motivo?: string; ordemId?: number };

export function corretoraReal(conta: Conta): CorretoraCcxt {
  if (!conta.api_key_cifrada || !conta.api_secret_cifrada) throw new Error('conta sem chave de API');
  return new CorretoraCcxt(
    conta.id,
    conta.exchange,
    {
      apiKey: decifrar(conta.api_key_cifrada, chave),
      secret: decifrar(conta.api_secret_cifrada, chave),
      ...(conta.api_senha_cifrada ? { password: decifrar(conta.api_senha_cifrada, chave) } : {}),
    },
    conta.testnet,
    hashToken(`${conta.api_key_cifrada}|${conta.api_secret_cifrada}|${conta.api_senha_cifrada ?? ''}|${conta.testnet}`),
  );
}

/** Cotação do par: pela conta (real) ou pública (simulação). null se a exchange não respondeu. */
async function cotar(conta: Conta, simbolo: string, real: boolean): Promise<number | null> {
  try {
    return real ? await corretoraReal(conta).cotacao(simbolo) : await cotacaoPublica(conta.exchange, simbolo);
  } catch (e) {
    logger.warn({ err: (e as Error).message, simbolo, exchange: conta.exchange }, 'cotação indisponível');
    return null;
  }
}

async function registrarSinal(
  c: pg.PoolClient,
  estrategiaId: number | null,
  sinal: Partial<Sinal>,
  corpo: unknown,
  ip: string | null,
  situacao: 'executado' | 'rejeitado' | 'ignorado' | 'erro',
  motivo: string | null,
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `insert into sinais (estrategia_id, id_externo, acao, corpo, ip, situacao, motivo)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [estrategiaId, sinal.id ?? null, sinal.acao ?? null, JSON.stringify(corpoComoJson(corpo)), ip, situacao, motivo],
  );
  return r.rows[0]!.id;
}

function corpoComoJson(corpo: unknown): unknown {
  if (typeof corpo !== 'string') return corpo ?? null;
  try {
    return JSON.parse(corpo);
  } catch {
    return { texto: corpo.slice(0, 2000) };
  }
}

async function carregarEstado(c: pg.PoolClient, est: Estrategia, conta: Conta) {
  const parada = await c.query<{ valor: boolean }>(`select valor from configuracoes where chave = 'parada_geral'`);
  const dia = await c.query<{ gasto: number; ultima: Date | null }>(
    `select coalesce(sum(custo) filter (
              where lado = 'compra'
                and criada_em >= (date_trunc('day', now() at time zone $2) at time zone $2)), 0) as gasto,
            max(criada_em) as ultima
       from ordens where estrategia_id = $1 and situacao = 'executada'`,
    [est.id, config.fuso],
  );
  const pos = await c.query<{ quantidade: number; custo_total: number }>(
    'select quantidade, custo_total from posicoes where estrategia_id = $1',
    [est.id],
  );
  return {
    paradaGeral: parada.rows[0]?.valor === true,
    gastoHoje: dia.rows[0]?.gasto ?? 0,
    ultimaOrdemEm: dia.rows[0]?.ultima ?? null,
    posicao: pos.rows[0] ?? { quantidade: 0, custo_total: 0 },
    conta: { modo: conta.modo },
  };
}

/**
 * Processa um sinal recebido no webhook. Um sinal por vez por estratégia (trava no banco), para
 * dois alertas simultâneos não furarem o limite diário.
 */
export async function processarSinal(token: string, corpo: unknown, ip: string | null): Promise<Resultado> {
  const est = await umOuNada<Estrategia>('select * from estrategias where token_hash = $1', [hashToken(token)]);
  if (!est) return { status: 404 };

  return transacao(async (c) => {
    await c.query('select pg_advisory_xact_lock(1, $1::int)', [est.id]);
    const conta = (await c.query<Conta>('select * from contas where id = $1', [est.conta_id])).rows[0]!;

    const leitura = lerSinal(corpo);
    if (!leitura.ok) {
      await registrarSinal(c, est.id, {}, corpo, ip, 'rejeitado', leitura.motivo);
      return { status: 400, situacao: 'rejeitado', motivo: leitura.motivo };
    }
    const sinal = leitura.sinal;

    if (sinal.id) {
      const repetido = await c.query('select 1 from sinais where estrategia_id = $1 and id_externo = $2', [est.id, sinal.id]);
      if (repetido.rowCount) return { status: 200, situacao: 'ignorado', motivo: 'sinal repetido (mesmo id)' };
    }

    const parcial = await carregarEstado(c, est, conta);
    const real = est.real && config.realLiberadoNoServidor && conta.modo === 'real';
    const cotacao = await cotar(conta, est.simbolo, real);
    const estado: EstadoRisco = {
      ...parcial,
      realNoServidor: config.realLiberadoNoServidor,
      estrategia: est,
      cotacao,
      agora: new Date(),
      ip,
    };
    const decisao = avaliar(sinal, estado);
    if (!decisao.aprovado) {
      await registrarSinal(c, est.id, sinal, corpo, ip, decisao.situacao, decisao.motivo);
      return { status: 200, situacao: decisao.situacao, motivo: decisao.motivo };
    }

    const precoAntes = cotacao ?? (decisao.modo === 'simulacao' ? sinal.preco ?? null : null);
    if (precoAntes === null) {
      const motivo = 'sem cotação da exchange (e o sinal não trouxe "preco" para a simulação)';
      await registrarSinal(c, est.id, sinal, corpo, ip, 'rejeitado', motivo);
      return { status: 200, situacao: 'rejeitado', motivo };
    }

    // Nota da análise dos 5 agentes, se a estratégia exige (só compras; só barra)
    if (est.analise_nota_min !== null && sinal.acao === 'comprar') {
      const ultima = (await c.query<AnaliseRecente>(
        `select nota, terminada_em from analises where simbolo = $1 and situacao = 'pronta' order by terminada_em desc limit 1`,
        [est.simbolo],
      )).rows[0] ?? null;
      const conferida = conferirAnalise(sinal.acao, ultima, est, new Date());
      if (!conferida.ok) {
        await registrarSinal(c, est.id, sinal, corpo, ip, 'rejeitado', conferida.motivo);
        return { status: 200, situacao: 'rejeitado', motivo: conferida.motivo };
      }
    }

    // Parecer das IAs: só depois que as regras aprovaram, e só para barrar.
    let pareceres: RespostaIa[] = [];
    let preco = precoAntes;
    const politica = politicaIa(est);
    if (consultaIa(sinal.acao, politica)) {
      const conectores = await conectoresDa(c, est);
      pareceres = await consultarIas(conectores, {
        estrategia: est.nome,
        contexto: est.ia_contexto,
        simbolo: est.simbolo,
        lado: decisao.lado,
        modo: decisao.modo,
        ...(decisao.lado === 'compra' ? { valor: decisao.valor } : { quantidade: decisao.quantidade }),
        cotacao,
        ...(sinal.preco !== undefined ? { preco_do_sinal: sinal.preco } : {}),
        posicao: parcial.posicao,
        gasto_hoje: parcial.gastoHoje,
        limite_diario: est.limite_diario,
      });
      const veredito = decidirComIa(
        pareceres.map((r) => (r.ok ? { ok: true as const, decisao: r.parecer.decisao, confianca: r.parecer.confianca } : { ok: false as const })),
        politica,
      );
      logger.info({ estrategia: est.id, aprovado: veredito.aprovado, motivo: veredito.motivo }, 'parecer das IAs');
      if (!veredito.aprovado) {
        const sinalId = await registrarSinal(c, est.id, sinal, corpo, ip, 'rejeitado', veredito.motivo);
        await gravarPareceres(c, sinalId, est.id, pareceres);
        return { status: 200, situacao: 'rejeitado', motivo: veredito.motivo };
      }
      // a consulta levou alguns segundos: atualiza a cotação, se der
      if (cotacao !== null) preco = (await cotar(conta, est.simbolo, decisao.modo === 'real')) ?? preco;
    }

    const { base, cotacao: moedaCotacao } = moedas(est.simbolo);
    let exec: Execucao;
    try {
      if (decisao.modo === 'real') {
        const corretora = corretoraReal(conta);
        exec = decisao.lado === 'compra'
          ? await corretora.comprar(est.simbolo, decisao.valor, preco)
          : await corretora.vender(est.simbolo, decisao.quantidade, preco);
      } else if (decisao.lado === 'compra') {
        const saldo = await saldoSimulado(c, conta.id, moedaCotacao);
        if (saldo + EPS < decisao.valor) {
          const motivo = `saldo simulado insuficiente: ${saldo} ${moedaCotacao}, precisa de ${decisao.valor}`;
          await gravarPareceres(c, await registrarSinal(c, est.id, sinal, corpo, ip, 'rejeitado', motivo), est.id, pareceres);
          return { status: 200, situacao: 'rejeitado', motivo };
        }
        exec = simularCompra(decisao.valor, preco, conta.taxa_simulada_pct);
      } else {
        exec = simularVenda(decisao.quantidade, preco, conta.taxa_simulada_pct);
      }
    } catch (e) {
      const erro = (e as Error).message.slice(0, 500);
      logger.error({ estrategia: est.id, modo: decisao.modo, erro }, 'exchange recusou a ordem');
      const sinalId = await registrarSinal(c, est.id, sinal, corpo, ip, 'erro', erro);
      await gravarPareceres(c, sinalId, est.id, pareceres);
      await c.query(
        `insert into ordens (estrategia_id, conta_id, sinal_id, modo, simbolo, lado, quantidade, preco_medio, custo, situacao, erro)
         values ($1, $2, $3, $4, $5, $6, 0, 0, 0, 'erro', $7)`,
        [est.id, conta.id, sinalId, decisao.modo, est.simbolo, decisao.lado, erro],
      );
      return { status: 502, situacao: 'erro', motivo: erro };
    }

    // A ordem já saiu. Se algo falhar daqui para baixo, este log é a prova de que ela existe.
    logger.info({ estrategia: est.id, modo: decisao.modo, lado: decisao.lado, simbolo: est.simbolo, exec }, 'ordem executada');

    const sinalId = await registrarSinal(c, est.id, sinal, corpo, ip, 'executado', null);
    await gravarPareceres(c, sinalId, est.id, pareceres);
    const ordem = await c.query<{ id: number }>(
      `insert into ordens (estrategia_id, conta_id, sinal_id, modo, simbolo, lado, quantidade, preco_medio, custo, taxa, id_exchange, situacao)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'executada') returning id`,
      [est.id, conta.id, sinalId, decisao.modo, est.simbolo, decisao.lado, exec.quantidade, exec.precoMedio, exec.custo, exec.taxa, exec.idExchange],
    );
    await atualizarPosicao(c, est.id, decisao.lado, exec, parcial.posicao);
    if (decisao.modo === 'simulacao') {
      if (decisao.lado === 'compra') {
        await moverSaldo(c, conta.id, moedaCotacao, -exec.custo);
        await moverSaldo(c, conta.id, base, exec.quantidade);
      } else {
        await moverSaldo(c, conta.id, base, -exec.quantidade);
        await moverSaldo(c, conta.id, moedaCotacao, exec.custo - exec.taxa);
      }
    }
    return { status: 200, situacao: 'executado', ordemId: ordem.rows[0]!.id };
  });
}

async function saldoSimulado(c: pg.PoolClient, contaId: number, moeda: string): Promise<number> {
  const r = await c.query<{ quantidade: number }>(
    'select quantidade from saldos_simulados where conta_id = $1 and moeda = $2',
    [contaId, moeda],
  );
  return r.rows[0]?.quantidade ?? 0;
}

async function moverSaldo(c: pg.PoolClient, contaId: number, moeda: string, delta: number): Promise<void> {
  await c.query(
    `insert into saldos_simulados (conta_id, moeda, quantidade) values ($1, $2, greatest($3::numeric, 0))
     on conflict (conta_id, moeda) do update set quantidade = greatest(saldos_simulados.quantidade + $3::numeric, 0)`,
    [contaId, moeda, delta],
  );
}

async function atualizarPosicao(
  c: pg.PoolClient,
  estrategiaId: number,
  lado: 'compra' | 'venda',
  exec: Execucao,
  antes: { quantidade: number; custo_total: number },
): Promise<void> {
  let quantidade: number;
  let custo: number;
  if (lado === 'compra') {
    quantidade = antes.quantidade + exec.quantidade;
    custo = antes.custo_total + exec.custo;
  } else {
    const vendida = Math.min(exec.quantidade, antes.quantidade);
    const fracao = antes.quantidade > 0 ? vendida / antes.quantidade : 1;
    quantidade = antes.quantidade - vendida;
    custo = antes.custo_total * (1 - fracao);
    if (quantidade < EPS) {
      quantidade = 0;
      custo = 0;
    }
  }
  await c.query(
    `insert into posicoes (estrategia_id, quantidade, custo_total, atualizada_em) values ($1, $2, $3, now())
     on conflict (estrategia_id) do update set quantidade = $2, custo_total = $3, atualizada_em = now()`,
    [estrategiaId, quantidade, custo],
  );
}
