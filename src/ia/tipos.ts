// Tipos dos conectores de IA. Um conector é um modelo de um provedor; a chave fica cifrada no
// banco como as das exchanges e nunca volta para o painel.

export type Provedor = 'anthropic' | 'openai';
export type Esforco = 'low' | 'medium' | 'high';

export interface ConectorIa {
  id: number;
  nome: string;
  provedor: Provedor;
  url_base: string | null;
  modelo: string;
  api_key_cifrada: string | null;
  esforco: Esforco;
  timeout_seg: number;
  instrucoes: string | null;
  ativo: boolean;
  ultimo_teste: { ok: boolean; ms: number; em: string; erro?: string } | null;
}

/** O que a IA recebe para opinar sobre uma ordem. Tudo aqui já passou pelas regras de risco. */
export interface PedidoParecer {
  estrategia: string;
  contexto: string | null;
  simbolo: string;
  lado: 'compra' | 'venda';
  modo: 'simulacao' | 'real';
  valor?: number;
  quantidade?: number;
  cotacao: number | null;
  preco_do_sinal?: number;
  posicao: { quantidade: number; custo_total: number };
  gasto_hoje: number;
  limite_diario: number;
  /** campos extras do sinal ou do escritório (indicadores, motivo do analista...) */
  extras?: Record<string, unknown>;
}

export interface Parecer {
  decisao: 'aprovar' | 'vetar';
  confianca: number;
  motivo: string;
}

export type RespostaIa =
  | { conector_id: number; conector: string; modelo: string; ok: true; parecer: Parecer; ms: number }
  | { conector_id: number; conector: string; modelo: string; ok: false; erro: string; ms: number };

export class ErroIa extends Error {}
