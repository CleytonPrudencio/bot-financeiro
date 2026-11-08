// "Por que não está comprando?": junta o que cada estratégia disse na última passada do piloto em
// poucos grupos (função pura, testada), para o painel mostrar a causa sem precisar abrir uma por uma.

export type Grupo =
  | 'comprou' | 'posicao' | 'parada' | 'manual' | 'aguardando' | 'bolsa_fechada' | 'limite_ia' | 'sem_saldo'
  | 'ia_vetou' | 'ia_falhou' | 'risco_barrou' | 'erro_ordem' | 'erro_piloto' | 'acao_cara' | 'sem_sinal' | 'aviso' | 'outro';

export const ROTULOS: Record<Grupo, string> = {
  comprou: 'Comprou na última passada',
  posicao: 'Com posição aberta (cuidando do stop e do alvo)',
  parada: 'Estratégia desligada',
  manual: 'Sem piloto: só compra por webhook ou pelos botões',
  aguardando: 'Esperando a primeira passada do piloto',
  bolsa_fechada: 'Bolsa fechada agora',
  limite_ia: 'Chegou no limite diário de consultas à IA',
  sem_saldo: 'Sem saldo livre na conta para comprar',
  ia_vetou: 'Achou entrada, mas a IA vetou',
  ia_falhou: 'Achou entrada, mas a IA não respondeu (sem crédito, limite de uso ou fora do ar)',
  risco_barrou: 'Achou entrada, mas uma regra de risco barrou',
  erro_ordem: 'Achou entrada, mas a ordem deu erro',
  erro_piloto: 'Erro no piloto (cotação ou velas)',
  acao_cara: 'Ação mais cara que o valor por ordem',
  sem_sinal: 'Mercado sem sinal de entrada agora',
  aviso: 'Esperando você responder o aviso',
  outro: 'Outro motivo',
};

export interface SituacaoEstrategia {
  ativa: boolean;
  auto_ligado: boolean;
  posicao: number;
  auto_situacao: string | null;
}

export function grupoDaSituacao(e: SituacaoEstrategia): Grupo {
  if (!e.ativa) return 'parada';
  if (!e.auto_ligado) return 'manual';
  if (e.posicao > 0) return 'posicao';
  const t = e.auto_situacao;
  if (!t) return 'aguardando';
  if (/B3 fechada/i.test(t)) return 'bolsa_fechada';
  if (/já consultou a IA/i.test(t)) return 'limite_ia';
  if (/saldo livre/i.test(t)) return 'sem_saldo';
  if (/aguardando a sua resposta/i.test(t)) return 'aviso';
  if (/→ executado/.test(t)) return 'comprou';
  // "0 aprovaram, 0 vetaram, 1 falharam": ninguém votou, a IA nem respondeu
  if (/→ (rejeitado|ignorado)/.test(t) && /0 aprovaram, 0 vetaram, \d+ falharam|nenhum conector de IA/i.test(t)) return 'ia_falhou';
  if (/→ (rejeitado|ignorado)/.test(t)) return /IA (barrou|obrigatória)|agente|vet/i.test(t) ? 'ia_vetou' : 'risco_barrou';
  if (/→ erro/.test(t)) return 'erro_ordem';
  if (/falhou nesta passada/i.test(t)) return 'erro_piloto';
  if (/entraria, mas 1 ação custa/i.test(t)) return 'acao_cara';
  if (/nenhum .*para alta agora|nenhum par em/i.test(t)) return 'sem_sinal';
  return 'outro';
}

/** Conta as estratégias por grupo, do maior para o menor, com até 3 exemplos de cada. */
export function agrupar<T extends SituacaoEstrategia & { nome: string }>(estrategias: T[]) {
  const grupos = new Map<Grupo, { grupo: Grupo; rotulo: string; n: number; exemplos: { nome: string; situacao: string | null }[] }>();
  for (const e of estrategias) {
    const g = grupoDaSituacao(e);
    const atual = grupos.get(g) ?? { grupo: g, rotulo: ROTULOS[g], n: 0, exemplos: [] };
    atual.n += 1;
    if (atual.exemplos.length < 3) atual.exemplos.push({ nome: e.nome, situacao: e.auto_situacao });
    grupos.set(g, atual);
  }
  return [...grupos.values()].sort((a, b) => b.n - a.n);
}
