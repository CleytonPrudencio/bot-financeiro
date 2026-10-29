import type pg from 'pg';
import { query, transacao, umOuNada } from '../db.js';
import { logger } from '../logger.js';
import { atualizarPosicao } from '../motor.js';
import { editar, enviar, lerTelegram, novidades, parear, responderBotao, type Atualizacao } from './telegram.js';
import { codigo, COMPRA_EXPIRA_MIN, lerResposta, reais, textoDoAlerta } from './textos.js';

export { COMPRA_EXPIRA_MIN, lerResposta, textoDoAlerta } from './textos.js';

// Assistente: ações da B3 sem API de corretora (ex.: XP). Quando uma ordem real de conta "b3"
// passa por tudo (regras, agente e as três chaves), o motor não manda ordem: cria um AVISO aqui e
// o dono recebe no Telegram (e no painel) o que fazer na corretora, com o stop para registrar lá.
// A ordem só entra no histórico (e na posição) quando o dono confirma o que executou.
//
// Compra expira em 30 min (o preço anda); aviso de venda fica até a resposta.

export interface Alerta {
  id: number;
  estrategia_id: number;
  sinal_id: number | null;
  lado: 'compra' | 'venda';
  simbolo: string;
  quantidade: number;
  preco_ref: number;
  stop: number | null;
  alvo: number | null;
  motivo: string | null;
  situacao: 'pendente' | 'confirmado' | 'recusado' | 'expirado';
  telegram_msg_id: number | null;
  pergunta_msg_id: number | null;
  expira_em: Date | null;
}

// ------------------------------------------------------------------ ciclo do aviso

/** Cria o aviso dentro da transação do motor (com a estratégia travada). */
export async function criarAlerta(
  c: pg.PoolClient,
  a: Pick<Alerta, 'estrategia_id' | 'sinal_id' | 'lado' | 'simbolo' | 'quantidade' | 'preco_ref' | 'stop' | 'alvo' | 'motivo'>,
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `insert into alertas (estrategia_id, sinal_id, lado, simbolo, quantidade, preco_ref, stop, alvo, motivo, expira_em)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $3 = 'compra' then now() + make_interval(mins => $10) end) returning id`,
    [a.estrategia_id, a.sinal_id, a.lado, a.simbolo, a.quantidade, a.preco_ref, a.stop, a.alvo, a.motivo, COMPRA_EXPIRA_MIN],
  );
  return r.rows[0]!.id;
}

/** Manda o aviso no Telegram (depois que a transação do motor gravou). Sem Telegram, fica só no painel. */
export async function notificarAlerta(id: number): Promise<void> {
  const a = await umOuNada<Alerta>('select * from alertas where id = $1', [id]);
  if (!a || a.situacao !== 'pendente') return;
  const botoes =
    a.lado === 'compra'
      ? [[{ texto: `✅ Comprei a ${reais(a.preco_ref)}`, dado: `c:${id}` }], [{ texto: '✏️ Comprei a outro preço', dado: `p:${id}` }, { texto: '❌ Não comprei', dado: `n:${id}` }]]
      : [[{ texto: `✅ Vendi a ${reais(a.preco_ref)}`, dado: `c:${id}` }], [{ texto: '✏️ Já vendi (outro preço)', dado: `p:${id}` }, { texto: '⏸ Ainda tenho', dado: `n:${id}` }]];
  try {
    const msg = await enviar(textoDoAlerta(a), botoes);
    if (msg) await query('update alertas set telegram_msg_id = $2 where id = $1', [id, msg]);
  } catch (e) {
    logger.warn({ alerta: id, err: (e as Error).message }, 'aviso não foi para o Telegram (segue no painel)');
  }
}

/** O motor chama de dentro da transação: o envio sai logo depois que ela grava. */
export function agendarAviso(id: number): void {
  setTimeout(() => void notificarAlerta(id).catch(() => undefined), 300).unref();
}

export type Resposta = { ok: boolean; texto: string };

/** O dono executou na corretora: grava a ordem (manual) e atualiza a posição, na trava da estratégia. */
export async function confirmarAlerta(id: number, r: { preco?: number; quantidade?: number } = {}): Promise<Resposta> {
  const resposta = await transacao<Resposta>(async (c) => {
    const a0 = (await c.query<Alerta>('select * from alertas where id = $1', [id])).rows[0];
    if (!a0) return { ok: false, texto: 'esse aviso não existe' };
    await c.query('select pg_advisory_xact_lock(1, $1::int)', [a0.estrategia_id]);
    const a = (await c.query<Alerta & { conta_id: number }>('select a.*, e.conta_id from alertas a join estrategias e on e.id = a.estrategia_id where a.id = $1', [id])).rows[0]!;
    if (a.situacao !== 'pendente') return { ok: false, texto: `esse aviso já está ${a.situacao}` };
    if (a.lado === 'compra' && a.expira_em && new Date(a.expira_em).getTime() < Date.now()) {
      await c.query(`update alertas set situacao = 'expirado', respondido_em = now() where id = $1`, [id]);
      return { ok: false, texto: 'esse aviso de compra já expirou: se você comprou mesmo assim, registre a ordem no painel' };
    }
    const preco = r.preco ?? Number(a.preco_ref);
    let quantidade = r.quantidade ?? Number(a.quantidade);
    if (!(preco > 0) || !(quantidade > 0)) return { ok: false, texto: 'preço e quantidade precisam ser maiores que zero' };
    const pos = (await c.query<{ quantidade: number; custo_total: number }>('select quantidade, custo_total from posicoes where estrategia_id = $1', [a.estrategia_id])).rows[0] ?? { quantidade: 0, custo_total: 0 };
    if (a.lado === 'venda') {
      if (pos.quantidade <= 0) return { ok: false, texto: 'a estratégia não tem posição aberta para vender' };
      quantidade = Math.min(quantidade, pos.quantidade);
    }
    const exec = { quantidade, precoMedio: preco, custo: quantidade * preco, taxa: 0, idExchange: null };
    // a ordem já foi executada pelo dono na corretora: este log é a prova dela, antes de gravar
    logger.info({ estrategia: a.estrategia_id, alerta: id, lado: a.lado, simbolo: a.simbolo, exec }, 'ordem executada (manual, confirmada pelo dono)');
    await c.query(
      `insert into ordens (estrategia_id, conta_id, sinal_id, modo, simbolo, lado, quantidade, preco_medio, custo, taxa, situacao, manual)
       values ($1, $2, $3, 'real', $4, $5, $6, $7, $8, 0, 'executada', true)`,
      [a.estrategia_id, a.conta_id, a.sinal_id, a.simbolo, a.lado, quantidade, preco, exec.custo],
    );
    await atualizarPosicao(c, a.estrategia_id, a.lado, exec, pos);
    if (a.lado === 'compra' && a.stop) await c.query('update posicoes set stop_avisado = $2 where estrategia_id = $1', [a.estrategia_id, a.stop]);
    await c.query(
      `update alertas set situacao = 'confirmado', preco_executado = $2, quantidade_executada = $3, respondido_em = now() where id = $1`,
      [id, preco, quantidade],
    );
    const texto =
      a.lado === 'compra'
        ? `✅ Registrado: comprou ${quantidade} ${codigo(a.simbolo)} a ${reais(preco)}.${a.stop ? ` Não esqueça o STOP de venda em ${reais(Number(a.stop))} na XP.` : ''} Eu sigo de olho.`
        : `✅ Registrado: vendeu ${quantidade} ${codigo(a.simbolo)} a ${reais(preco)}.`;
    return { ok: true, texto };
  });
  if (resposta.ok) await fecharMensagem(id, resposta.texto);
  return resposta;
}

/** Não comprou (ou ainda tem a ação, no aviso de venda). */
export async function recusarAlerta(id: number): Promise<Resposta> {
  const r = await query<Alerta>(`update alertas set situacao = 'recusado', respondido_em = now() where id = $1 and situacao = 'pendente' returning *`, [id]);
  const a = r[0];
  if (!a) return { ok: false, texto: 'esse aviso não está mais esperando resposta' };
  const texto = a.lado === 'compra' ? `Ok, não comprou ${codigo(a.simbolo)}. Fica para a próxima.` : `Ok, você ainda tem ${codigo(a.simbolo)}. Aviso de novo se precisar.`;
  await fecharMensagem(id, texto);
  return { ok: true, texto };
}

async function fecharMensagem(id: number, texto: string): Promise<void> {
  const a = await umOuNada<Alerta>('select * from alertas where id = $1', [id]);
  if (a?.telegram_msg_id) await editar(a.telegram_msg_id, `${textoDoAlerta(a)}\n\n${texto}`);
}

/** Compra sem resposta em 30 min expira (o preço já andou). */
export async function expirarAlertas(): Promise<void> {
  const r = await query<Alerta>(
    `update alertas set situacao = 'expirado', respondido_em = now() where situacao = 'pendente' and lado = 'compra' and expira_em < now() returning *`,
  );
  for (const a of r) if (a.telegram_msg_id) await editar(a.telegram_msg_id, `${textoDoAlerta(a)}\n\n⌛ Expirou sem resposta: não registrei compra.`);
}

/** Já existe aviso desta estratégia esperando resposta (ou um de venda respondido há pouco)? */
export async function avisoEmAberto(estrategiaId: number, c?: pg.PoolClient): Promise<boolean> {
  const sql = `select 1 from alertas where estrategia_id = $1
                 and (situacao = 'pendente' or (lado = 'venda' and situacao = 'recusado' and respondido_em > now() - interval '30 minutes'))
               limit 1`;
  const linhas = c ? (await c.query(sql, [estrategiaId])).rows : await query(sql, [estrategiaId]);
  return linhas.length > 0;
}

export async function avisarStop(simbolo: string, quantidade: number, stop: number, motivo: string): Promise<void> {
  await enviar(`🔼 SUBA O STOP de ${codigo(simbolo)} na XP para ${reais(stop)}\n${motivo}\n(posição: ${quantidade} ${quantidade === 1 ? 'ação' : 'ações'})`).catch((e) =>
    logger.warn({ err: (e as Error).message }, 'aviso de stop não foi para o Telegram'),
  );
}

// ------------------------------------------------------------------ Telegram: respostas do dono

/** Trata uma novidade do Telegram. Exportada para os testes. */
export async function tratarAtualizacao(u: Atualizacao): Promise<void> {
  const t = await lerTelegram();
  if (!t) return;
  const texto = u.message?.text?.trim() ?? '';
  // pareamento: só quem manda o código que o painel mostrou vira o dono
  if (u.message && /^\/start\b/.test(texto)) {
    if (texto.split(/\s+/)[1]?.toUpperCase() === t.codigo) {
      await parear(u.message.chat.id);
      await enviar('Pronto: este chat recebe os avisos do Bot Financeiro. Quando chegar uma compra ou venda, é só responder nos botões.');
    }
    return;
  }
  const chat = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
  if (!t.chat_id || chat !== t.chat_id) return; // ninguém além do dono

  if (u.callback_query?.data) {
    const [acao, idTexto] = u.callback_query.data.split(':');
    const id = Number(idTexto);
    let r: Resposta;
    if (acao === 'c') r = await confirmarAlerta(id);
    else if (acao === 'n') r = await recusarAlerta(id);
    else if (acao === 'p') {
      const msg = await enviar('Qual foi o preço médio e a quantidade? Responda esta mensagem, por exemplo: 38,10 1', [], {
        reply_markup: { force_reply: true, input_field_placeholder: '38,10 1' },
      });
      if (msg) await query('update alertas set pergunta_msg_id = $2 where id = $1', [id, msg]);
      r = { ok: true, texto: 'Me diga o preço e a quantidade' };
    } else r = { ok: false, texto: 'botão desconhecido' };
    await responderBotao(u.callback_query.id, r.texto);
    if (!r.ok) await enviar(`⚠️ ${r.texto}`);
    return;
  }

  const respondida = u.message?.reply_to_message?.message_id;
  if (respondida) {
    const a = await umOuNada<{ id: number }>(`select id from alertas where pergunta_msg_id = $1 and situacao = 'pendente'`, [respondida]);
    if (!a) return;
    const lido = lerResposta(texto);
    if (!lido) return void (await enviar('Não entendi. Responda com o preço e a quantidade, por exemplo: 38,10 1'));
    const r = await confirmarAlerta(a.id, lido);
    await enviar(r.ok ? r.texto : `⚠️ ${r.texto}`);
  }
}

/** Laço do assistente: novidades do Telegram (long polling) e expiração dos avisos. */
export function iniciarAssistente(): () => void {
  let ligado = true;
  let offset = 0;
  const expirar = setInterval(() => void expirarAlertas().catch(() => undefined), 60_000);
  expirar.unref();
  void (async () => {
    while (ligado) {
      try {
        const lista = await novidades(offset);
        if (!lista.length && !(await lerTelegram())) {
          await new Promise((r) => setTimeout(r, 30_000)); // sem Telegram configurado: confere de novo depois
          continue;
        }
        for (const u of lista) {
          offset = Math.max(offset, u.update_id + 1);
          await tratarAtualizacao(u).catch((e) => logger.warn({ err: (e as Error).message }, 'falha ao tratar mensagem do Telegram'));
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'Telegram indisponível; tento de novo em 15 s');
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  })();
  return () => {
    ligado = false;
    clearInterval(expirar);
  };
}
