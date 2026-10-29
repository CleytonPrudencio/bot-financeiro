import { config } from '../config.js';
import { decifrar, derivarChave } from '../crypto.js';
import { logger } from '../logger.js';
import { chamarClaude, MODELOS_CLAUDE } from './anthropic.js';
import { chamarCompativel, limparErro, PRESETS_COMPATIVEIS } from './compativel.js';
import { ESQUEMA_PARECER, lerParecer, SISTEMA_PARECER, SISTEMA_PERGUNTA, textoDoPedido } from './prompt.js';
import { ErroIa, type ConectorIa, type PedidoParecer, type RespostaIa } from './tipos.js';

export { MODELOS_CLAUDE, PRESETS_COMPATIVEIS };
export type { ConectorIa, PedidoParecer, RespostaIa };

const chave = derivarChave(config.chaveCifra);

function chaveDo(c: ConectorIa): string | null {
  return c.api_key_cifrada ? decifrar(c.api_key_cifrada, chave) : null;
}

export interface OpcoesChamada {
  /** JSON Schema da resposta; no Claude vira saída estruturada, nos outros vai como JSON livre */
  esquema?: Record<string, unknown>;
  /** pesquisa na web (só Claude) */
  pesquisaWeb?: boolean;
  timeoutSeg?: number;
}

/** Chama um conector qualquer e devolve o texto da resposta. Lança ErroIa. */
export async function chamarIa(c: ConectorIa, sistema: string, texto: string, op: OpcoesChamada = {}): Promise<string> {
  const apiKey = chaveDo(c);
  if (c.provedor === 'anthropic') {
    if (!apiKey) throw new ErroIa('conector Claude sem chave de API');
    return chamarClaude(c, apiKey, sistema, texto, op);
  }
  return chamarCompativel(c, apiKey, sistema, texto, Boolean(op.esquema), op.timeoutSeg);
}

const chamar = (c: ConectorIa, sistema: string, texto: string, querJson: boolean) =>
  chamarIa(c, sistema, texto, querJson ? { esquema: ESQUEMA_PARECER } : {});

export function mensagemDeErro(c: ConectorIa, e: unknown): string {
  if (e instanceof ErroIa) return e.message;
  const msg = limparErro((e as Error).message ?? 'erro desconhecido', null);
  logger.warn({ conector: c.id, err: msg }, 'falha inesperada no conector de IA');
  return msg;
}

/** Pede o parecer de uma IA. Nunca lança: falha vira resposta com ok=false. */
export async function pedirParecer(c: ConectorIa, pedido: PedidoParecer): Promise<RespostaIa> {
  const inicio = Date.now();
  const base = { conector_id: c.id, conector: c.nome, modelo: c.modelo };
  try {
    const texto = await chamar(c, SISTEMA_PARECER, textoDoPedido(pedido, c.instrucoes), true);
    return { ...base, ok: true, parecer: lerParecer(texto), ms: Date.now() - inicio };
  } catch (e) {
    return { ...base, ok: false, erro: mensagemDeErro(c, e), ms: Date.now() - inicio };
  }
}

/** Todas ao mesmo tempo: o tempo total é o da mais lenta (limitado pelo timeout de cada uma). */
export function consultarIas(conectores: ConectorIa[], pedido: PedidoParecer): Promise<RespostaIa[]> {
  return Promise.all(conectores.map((c) => pedirParecer(c, pedido)));
}

export type RespostaLivre =
  | { conector_id: number; conector: string; modelo: string; ok: true; texto: string; ms: number }
  | { conector_id: number; conector: string; modelo: string; ok: false; erro: string; ms: number };

/** Pergunta livre do painel ("perguntar a todas"). */
export function perguntarIas(conectores: ConectorIa[], pergunta: string): Promise<RespostaLivre[]> {
  return Promise.all(
    conectores.map(async (c): Promise<RespostaLivre> => {
      const inicio = Date.now();
      const base = { conector_id: c.id, conector: c.nome, modelo: c.modelo };
      const sistema = c.instrucoes ? `${SISTEMA_PERGUNTA}\n\nOrientação do dono: ${c.instrucoes}` : SISTEMA_PERGUNTA;
      try {
        const texto = await chamar(c, sistema, pergunta, false);
        return { ...base, ok: true, texto: texto.replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, 8000), ms: Date.now() - inicio };
      } catch (e) {
        return { ...base, ok: false, erro: mensagemDeErro(c, e), ms: Date.now() - inicio };
      }
    }),
  );
}

/** Pedido de exemplo para o botão "testar" do painel. */
export const PEDIDO_DE_TESTE: PedidoParecer = {
  estrategia: 'teste do painel',
  contexto: 'Teste de conexão: não é uma ordem de verdade. Responda normalmente.',
  simbolo: 'BTC/USDT',
  lado: 'compra',
  modo: 'simulacao',
  valor: 50,
  cotacao: 65000,
  preco_do_sinal: 64980,
  posicao: { quantidade: 0, custo_total: 0 },
  gasto_hoje: 0,
  limite_diario: 500,
};
