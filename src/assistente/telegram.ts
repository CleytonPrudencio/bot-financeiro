import { config } from '../config.js';
import { cifrar, decifrar, derivarChave } from '../crypto.js';
import { query, umOuNada } from '../db.js';

// Bot do Telegram do assistente: só a conversa com a API (enviar, editar, receber). O token fica
// cifrado em configuracoes ('telegram') e nunca volta para o painel. Só o chat pareado (o dono, que
// mandou "/start <código>") recebe avisos e pode responder.

const chave = derivarChave(config.chaveCifra);

export interface ConfigTelegram {
  token_cifrado: string;
  bot: string;
  codigo: string;
  chat_id: number | null;
}

export async function lerTelegram(): Promise<ConfigTelegram | null> {
  const r = await umOuNada<{ valor: ConfigTelegram }>(`select valor from configuracoes where chave = 'telegram'`);
  return r?.valor?.token_cifrado ? r.valor : null;
}

async function gravar(valor: ConfigTelegram | null): Promise<void> {
  if (!valor) return void (await query(`delete from configuracoes where chave = 'telegram'`));
  await query(
    `insert into configuracoes (chave, valor) values ('telegram', $1) on conflict (chave) do update set valor = $1, alterado_em = now()`,
    [JSON.stringify(valor)],
  );
}

async function chamar<T>(token: string, metodo: string, corpo: object, timeoutMs = 15_000): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${config.telegramUrl}/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('sem conexão com o Telegram');
  }
  const d = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  // o token vai na URL: a mensagem de erro nunca leva a URL, só a descrição do Telegram
  if (!d.ok) throw new Error(`Telegram: ${(d.description ?? `erro ${r.status}`).slice(0, 150)}`);
  return d.result as T;
}

const codigoNovo = () => Math.random().toString(36).slice(2, 8).toUpperCase();

/** Confere o token no Telegram (getMe), guarda cifrado e gera o código de pareamento. */
export async function salvarToken(token: string): Promise<{ bot: string; codigo: string }> {
  const eu = await chamar<{ username: string }>(token, 'getMe', {});
  const valor: ConfigTelegram = { token_cifrado: cifrar(token, chave), bot: eu.username, codigo: codigoNovo(), chat_id: null };
  await gravar(valor);
  return { bot: valor.bot, codigo: valor.codigo };
}

export const desligarTelegram = () => gravar(null);

export async function parear(chatId: number): Promise<void> {
  const t = await lerTelegram();
  if (t) await gravar({ ...t, chat_id: chatId, codigo: codigoNovo() });
}

export type Botao = { texto: string; dado: string };

/** Manda uma mensagem ao dono; sem Telegram configurado e pareado, não faz nada (devolve null). */
export async function enviar(texto: string, botoes: Botao[][] = [], extra: object = {}): Promise<number | null> {
  const t = await lerTelegram();
  if (!t?.chat_id) return null;
  const m = await chamar<{ message_id: number }>(decifrar(t.token_cifrado, chave), 'sendMessage', {
    chat_id: t.chat_id,
    text: texto,
    ...(botoes.length ? { reply_markup: { inline_keyboard: botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dado }))) } } : {}),
    ...extra,
  });
  return m.message_id;
}

export async function editar(msgId: number, texto: string): Promise<void> {
  const t = await lerTelegram();
  if (!t?.chat_id) return;
  await chamar(decifrar(t.token_cifrado, chave), 'editMessageText', { chat_id: t.chat_id, message_id: msgId, text: texto }).catch(() => undefined);
}

export async function responderBotao(idCallback: string, texto: string): Promise<void> {
  const t = await lerTelegram();
  if (!t) return;
  await chamar(decifrar(t.token_cifrado, chave), 'answerCallbackQuery', { callback_query_id: idCallback, text: texto.slice(0, 190) }).catch(() => undefined);
}

export interface Atualizacao {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; reply_to_message?: { message_id: number } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
}

/** Busca as novidades (long polling de 25 s). */
export async function novidades(offset: number): Promise<Atualizacao[]> {
  const t = await lerTelegram();
  if (!t) return [];
  return chamar<Atualizacao[]>(decifrar(t.token_cifrado, chave), 'getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35_000);
}
