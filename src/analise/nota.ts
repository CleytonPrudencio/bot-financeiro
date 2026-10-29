import { z } from 'zod';
import { ErroIa } from '../ia/tipos.js';
import type { Agente } from './agentes.js';

// Leitura da resposta de cada agente e nota final (Trade Score), como no ai-trading-claude:
// técnico 25%, fundamental 25%, sentimento 20%, risco 15%, tese 15%. Agente que falhou sai da
// conta e os pesos dos outros são refeitos na proporção.

export interface ResultadoAgente {
  nota: number;
  subnotas: { nome: string; nota: number }[];
  sinal: string;
  resumo: string;
  pontos: string[];
  niveis: { entrada_min: number; entrada_max: number; stop: number; alvo1: number; alvo2: number } | null;
}

const lido = z.object({
  subnotas: z.array(z.object({ nome: z.string(), nota: z.coerce.number() })).min(1),
  sinal: z.string().default(''),
  resumo: z.string().default(''),
  pontos: z.array(z.string()).default([]),
  niveis: z
    .object({
      entrada_min: z.coerce.number().default(0),
      entrada_max: z.coerce.number().default(0),
      stop: z.coerce.number().default(0),
      alvo1: z.coerce.number().default(0),
      alvo2: z.coerce.number().default(0),
    })
    .nullable()
    .optional(),
});

const limitar = (x: number, a: number, b: number) => Math.min(b, Math.max(a, Number.isFinite(x) ? x : a));

export function lerAgente(resposta: string, a: Agente): ResultadoAgente {
  const texto = resposta.replace(/<think>[\s\S]*?<\/think>/g, '');
  const inicio = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (inicio < 0 || fim < inicio) throw new ErroIa('o agente não devolveu JSON');
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto.slice(inicio, fim + 1));
  } catch {
    throw new ErroIa('o agente devolveu JSON inválido');
  }
  const r = lido.safeParse(bruto);
  if (!r.success) throw new ErroIa('o agente respondeu fora do formato');
  // sempre as 5 subnotas da régua, na ordem; faltou alguma, vale 10 (neutro)
  const subnotas = a.subnotas.map((nome, i) => ({ nome, nota: Math.round(limitar(r.data.subnotas[i]?.nota ?? 10, 0, 20)) }));
  const n = r.data.niveis;
  const niveis = a.niveis && n && n.stop > 0 && n.alvo1 > 0 ? n : null;
  return {
    nota: subnotas.reduce((t, s) => t + s.nota, 0),
    subnotas,
    sinal: r.data.sinal.trim().slice(0, 40),
    resumo: r.data.resumo.trim().slice(0, 1200),
    pontos: r.data.pontos.map((p) => p.trim().slice(0, 300)).filter(Boolean).slice(0, 5),
    niveis,
  };
}

/** Nota final de 0 a 100; null se nenhum agente respondeu. */
export function notaComposta(partes: { peso: number; nota: number | null }[]): number | null {
  const validas = partes.filter((p) => p.nota !== null);
  const pesos = validas.reduce((t, p) => t + p.peso, 0);
  if (!validas.length || pesos <= 0) return null;
  return Math.round(validas.reduce((t, p) => t + p.peso * (p.nota as number), 0) / pesos);
}

export function conceito(nota: number): { conceito: string; sinal: string } {
  if (nota >= 85) return { conceito: 'A+', sinal: 'Compra forte' };
  if (nota >= 70) return { conceito: 'A', sinal: 'Compra' };
  if (nota >= 55) return { conceito: 'B', sinal: 'Manter / acumular' };
  if (nota >= 40) return { conceito: 'C', sinal: 'Neutro' };
  if (nota >= 25) return { conceito: 'D', sinal: 'Cautela' };
  return { conceito: 'F', sinal: 'Evitar' };
}
