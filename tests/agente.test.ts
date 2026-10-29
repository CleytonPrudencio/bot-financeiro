import { describe, expect, it } from 'vitest';
import { afinidade, ETAPAS, etapaDaPrevisao, lerEtapa, montarAutomatico, relatorios, sistemaDaEtapa, type ConectorResumido } from '../src/agente/etapas.js';

const conector = (id: number, provedor: 'anthropic' | 'openai', modelo: string, url_base: string | null = null): ConectorResumido => ({ id, provedor, modelo, url_base, ativo: true });

describe('leitura de cada etapa', () => {
  it('JSON com cerca de código; nota cortada em 0..100; viés desconhecido vira neutro', () => {
    expect(lerEtapa('```json\n{"vies":"a_favor","nota":140,"resumo":"ok","pontos":["a"]}\n```')).toEqual({ vies: 'a_favor', nota: 100, resumo: 'ok', pontos: ['a'] });
    expect(lerEtapa('{"vies":"talvez","nota":"40","resumo":"x"}')).toMatchObject({ vies: 'neutro', nota: 40, pontos: [] });
  });
  it('sem JSON é erro', () => {
    expect(() => lerEtapa('não sei')).toThrow();
  });
});

describe('relatórios para a decisão', () => {
  it('mostra etapa feita, que falhou e desligada', () => {
    const t = relatorios({
      pesquisa: { ok: true, conector: 'Perplexity', resultado: { vies: 'contra', nota: 30, resumo: 'notícia ruim', pontos: ['hack'] } },
      risco: { ok: false, conector: 'DeepSeek', erro: 'tempo esgotado' },
    });
    expect(t).toContain('## Pesquisa (Perplexity): contra, nota 30/100');
    expect(t).toContain('- hack');
    expect(t).toContain('## Risco (DeepSeek): FALHOU (tempo esgotado)');
    expect(t).toContain('## Sentimento: desligada');
  });
  it('avisa a decisão quando a etapa devia pesquisar na web e não pesquisou', () => {
    const r = { vies: 'neutro' as const, nota: 50, resumo: 'sem notícias', pontos: [] };
    const t = relatorios({
      pesquisa: { ok: true, conector: 'Claude', web: true, buscas: 0, resultado: r },
      sentimento: { ok: true, conector: 'Claude', web: true, buscas: 2, resultado: r },
    });
    expect(t).toContain('## Pesquisa (Claude): neutro, nota 50/100 (devia pesquisar na web e não pesquisou');
    expect(t).toContain('## Sentimento (Claude): neutro, nota 50/100\n');
  });
});

describe('pedido de cada etapa', () => {
  const pesquisa = ETAPAS.find((e) => e.id === 'pesquisa')!;
  it('com web: leva a data de hoje e manda fazer pelo menos uma busca', () => {
    const s = sistemaDaEtapa(pesquisa, true, new Date('2026-10-29T15:00:00Z'));
    expect(s).toContain('Hoje é 29/10/2026');
    expect(s).toContain('pelo menos uma busca');
    expect(s).not.toContain('não tem internet');
  });
  it('sem web: diz que não tem internet', () => {
    expect(sistemaDaEtapa(pesquisa, false)).toContain('não tem internet');
  });
});

describe('montar automático', () => {
  const opus = conector(1, 'anthropic', 'claude-opus-5-5');
  const grok = conector(2, 'openai', 'grok-4', 'https://api.x.ai/v1');
  const perplexity = conector(3, 'openai', 'sonar-pro', 'https://api.perplexity.ai');
  const qwen = conector(4, 'openai', 'qwen/qwen3-max', 'https://openrouter.ai/api/v1');
  const deepseek = conector(5, 'openai', 'deepseek-chat', 'https://api.deepseek.com/v1');

  it('cada etapa vai para a IA que mais combina', () => {
    expect(montarAutomatico([opus, grok, perplexity, qwen, deepseek])).toEqual({ pesquisa: 3, sentimento: 2, tecnica: 4, risco: 5, decisao: 1 });
  });
  it('com uma IA só, ela faz tudo; sem IA ativa, nada', () => {
    expect(new Set(Object.values(montarAutomatico([deepseek])))).toEqual(new Set([5]));
    expect(Object.values(montarAutomatico([{ ...opus, ativo: false }]))).toEqual([null, null, null, null, null]);
  });
  it('a decisão prefere o Claude Opus', () => {
    expect(afinidade(opus, 'decisao')).toBeGreaterThan(afinidade(deepseek, 'decisao'));
  });
});

describe('previsão do Kronos como etapa', () => {
  const p = (chance: number) => ({ retorno_mediano_pct: 1.2, faixa_10_a_90_pct: [-3, 4] as [number, number], chance_de_terminar_acima: chance, horizonte_dias: 5 });
  it('compra: a favor com 60% ou mais de chance de alta, contra com 40% ou menos', () => {
    expect(etapaDaPrevisao(p(0.7), 'compra')).toMatchObject({ vies: 'a_favor', nota: 70 });
    expect(etapaDaPrevisao(p(0.5), 'compra')).toMatchObject({ vies: 'neutro', nota: 50 });
    expect(etapaDaPrevisao(p(0.3), 'compra')).toMatchObject({ vies: 'contra', nota: 30 });
  });
  it('venda: o contrário', () => {
    expect(etapaDaPrevisao(p(0.3), 'venda')).toMatchObject({ vies: 'a_favor', nota: 70 });
  });
  it('resumo com mediana, faixa e chance', () => {
    expect(etapaDaPrevisao(p(0.62), 'compra').resumo).toBe('Em 5 dias o Kronos projeta +1.20% (mediana), com faixa de -3.00% a +4.00% e 62% de chance de terminar acima de hoje.');
  });
});
