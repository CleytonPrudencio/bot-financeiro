import Anthropic from '@anthropic-ai/sdk';
import { ErroIa, type ConectorIa } from './tipos.js';

// Claude pelo SDK oficial da Anthropic.
//
// - `fallbacks: "default"`: se o modelo recusar por política, a própria API refaz o pedido no
//   modelo reserva que a Anthropic recomenda, dentro da mesma chamada (beta
//   server-side-fallback-2026-07-01). Em modelo sem reserva, o pedido roda só no modelo pedido.
// - O pensamento adaptativo já vem ligado nos modelos atuais; a profundidade é o `effort`.
// - Sem novas tentativas (maxRetries 0): o sinal está esperando, o tempo máximo é o do conector.

export const MODELOS_CLAUDE = [
  { id: 'claude-opus-5-5', nome: 'Claude Opus 5.5 (mais capaz)' },
  { id: 'claude-sonnet-5-5', nome: 'Claude Sonnet 5.5 (equilíbrio)' },
  { id: 'claude-haiku-5-5', nome: 'Claude Haiku 5.5 (rápido e barato)' },
];

const MAX_TOKENS = { low: 4096, medium: 8192, high: 16000 } as const;

export interface OpcoesClaude {
  /** JSON Schema da resposta (saída estruturada). Não vale junto com a pesquisa na web. */
  esquema?: Record<string, unknown>;
  /** Liga a ferramenta de pesquisa na web do servidor da Anthropic (custo extra por busca). */
  pesquisaWeb?: boolean;
  /** Tempo máximo em segundos; padrão: o do conector. */
  timeoutSeg?: number;
}

export async function chamarClaude(c: ConectorIa, apiKey: string, sistema: string, texto: string, op: OpcoesClaude = {}): Promise<string> {
  const cliente = new Anthropic({ apiKey, timeout: (op.timeoutSeg ?? c.timeout_seg) * 1000, maxRetries: 0 });
  const mensagens: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: texto }];
  let r;
  // a pesquisa na web pode pausar o turno (pause_turn): devolve o turno para o servidor continuar
  for (let volta = 0; volta < 4; volta++) {
    try {
      r = await cliente.beta.messages.create({
        model: c.modelo,
        max_tokens: MAX_TOKENS[c.esforco],
        system: sistema,
        messages: mensagens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        ...(op.pesquisaWeb ? { tools: [{ type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: 4 }] } : {}),
        output_config: {
          effort: c.esforco,
          ...(op.esquema && !op.pesquisaWeb ? { format: { type: 'json_schema' as const, schema: op.esquema } } : {}),
        },
      });
    } catch (e) {
      throw new ErroIa(erroClaude(e));
    }
    if (r.stop_reason !== 'pause_turn') break;
    mensagens.push({ role: 'assistant', content: r.content });
  }
  if (!r || r.stop_reason === 'pause_turn') throw new ErroIa('a pesquisa na web não terminou a tempo');
  if (r.stop_reason === 'refusal') throw new ErroIa('o modelo recusou responder');
  if (r.stop_reason === 'max_tokens') throw new ErroIa('resposta cortada no limite de tokens');
  const saida = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
  if (!saida) throw new ErroIa('resposta vazia');
  return saida;
}

function erroClaude(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'chave de API da Anthropic inválida';
  if (e instanceof Anthropic.PermissionDeniedError) return 'a chave não tem permissão para este modelo';
  if (e instanceof Anthropic.NotFoundError) return 'modelo não encontrado';
  if (e instanceof Anthropic.RateLimitError) return 'limite de uso da API atingido; tente mais tarde';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'tempo esgotado';
  if (e instanceof Anthropic.APIConnectionError) return 'sem conexão com a API da Anthropic';
  if (e instanceof Anthropic.BadRequestError) return `pedido recusado pela API: ${e.message.slice(0, 200)}`;
  if (e instanceof Anthropic.APIError) return `erro ${e.status ?? '?'} da API da Anthropic`;
  return (e as Error).message?.slice(0, 200) ?? 'erro desconhecido';
}
