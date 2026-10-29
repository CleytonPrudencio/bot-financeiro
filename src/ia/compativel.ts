import { ErroIa, type ConectorIa } from './tipos.js';

// Qualquer API no formato "chat completions" da OpenAI: ChatGPT, Gemini (endpoint compatível),
// OpenRouter, Groq, DeepSeek, Mistral, xAI, Ollama... Muda só a URL base, o modelo e a chave.

export const PRESETS_COMPATIVEIS = [
  { id: 'openai', nome: 'OpenAI (ChatGPT)', url_base: 'https://api.openai.com/v1', precisa_chave: true },
  { id: 'gemini', nome: 'Google Gemini', url_base: 'https://generativelanguage.googleapis.com/v1beta/openai', precisa_chave: true },
  { id: 'openrouter', nome: 'OpenRouter (centenas de modelos)', url_base: 'https://openrouter.ai/api/v1', precisa_chave: true },
  { id: 'groq', nome: 'Groq', url_base: 'https://api.groq.com/openai/v1', precisa_chave: true },
  { id: 'deepseek', nome: 'DeepSeek', url_base: 'https://api.deepseek.com/v1', precisa_chave: true },
  { id: 'mistral', nome: 'Mistral', url_base: 'https://api.mistral.ai/v1', precisa_chave: true },
  { id: 'xai', nome: 'xAI (Grok)', url_base: 'https://api.x.ai/v1', precisa_chave: true },
  { id: 'ollama', nome: 'Ollama da VM (saplink-ollama, grátis)', url_base: 'http://saplink-ollama:11434/v1', precisa_chave: false, modelo: 'qwen2.5:7b' },
  { id: 'outro', nome: 'Outro compatível com OpenAI', url_base: '', precisa_chave: false },
];

/** Tira a chave (e qualquer coisa com cara de chave) de uma mensagem de erro do provedor. */
export function limparErro(msg: string, apiKey: string | null): string {
  let m = msg;
  if (apiKey) m = m.split(apiKey).join('***');
  return m.replace(/\b(sk|gsk|xai|AIza)[-_A-Za-z0-9]{8,}/g, '***').slice(0, 300);
}

interface RespostaChat {
  choices?: { message?: { content?: string | { type: string; text?: string }[] | null; refusal?: string | null } }[];
  error?: { message?: string } | string;
}

export async function chamarCompativel(
  c: ConectorIa,
  apiKey: string | null,
  sistema: string,
  texto: string,
  querJson: boolean,
): Promise<string> {
  if (!c.url_base) throw new ErroIa('conector sem URL base');
  const url = c.url_base.replace(/\/+$/, '') + '/chat/completions';
  const corpo = (comFormato: boolean) =>
    JSON.stringify({
      model: c.modelo,
      messages: [
        { role: 'system', content: sistema },
        { role: 'user', content: texto },
      ],
      ...(comFormato ? { response_format: { type: 'json_object' } } : {}),
    });

  const pedir = async (comFormato: boolean) => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: corpo(comFormato),
        signal: AbortSignal.timeout(c.timeout_seg * 1000),
        redirect: 'error',
      });
    } catch (e) {
      const nome = (e as Error).name;
      throw new ErroIa(nome === 'TimeoutError' ? 'tempo esgotado' : `sem conexão com ${new URL(url).host}`);
    }
  };

  let r = await pedir(querJson);
  // nem todo provedor aceita response_format: tenta de novo sem ele
  if (r.status === 400 && querJson) r = await pedir(false);
  const dados = (await r.json().catch(() => ({}))) as RespostaChat;
  if (!r.ok) {
    const detalhe = typeof dados.error === 'string' ? dados.error : dados.error?.message;
    if (r.status === 401 || r.status === 403) throw new ErroIa('chave de API inválida ou sem permissão');
    if (r.status === 429) throw new ErroIa('limite de uso da API atingido; tente mais tarde');
    throw new ErroIa(limparErro(`erro ${r.status}${detalhe ? `: ${detalhe}` : ''}`, apiKey));
  }
  const msg = dados.choices?.[0]?.message;
  if (msg?.refusal) throw new ErroIa('o modelo recusou responder');
  const conteudo = msg?.content;
  const saida = (typeof conteudo === 'string' ? conteudo : (conteudo ?? []).map((p) => p.text ?? '').join('')).trim();
  if (!saida) throw new ErroIa('resposta vazia');
  return saida;
}
