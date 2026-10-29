import { describe, expect, it } from 'vitest';
import { AGENTES } from '../src/analise/agentes.js';
import { atrPct, ifr, macd, mediaSimples, quedas, resumoTecnico, retornoPct, volatilidadeAnual, type Vela } from '../src/analise/indicadores.js';
import { conceito, lerAgente, notaComposta } from '../src/analise/nota.js';
import { conferirAnalise } from '../src/risco.js';

const velas = (fechamentos: number[]): Vela[] =>
  fechamentos.map((f, i) => ({ t: Date.UTC(2026, 0, 1) + i * 86_400_000, abre: f, max: f * 1.01, min: f * 0.99, fecha: f, volume: 100 + i }));

describe('indicadores', () => {
  it('média, IFR e retorno', () => {
    expect(mediaSimples([1, 2, 3, 4], 2)).toBe(3.5);
    expect(mediaSimples([1], 2)).toBeNull();
    expect(ifr(Array.from({ length: 30 }, (_, i) => 100 + i))).toBe(100);
    expect(ifr(Array.from({ length: 30 }, (_, i) => 100 - i))).toBe(0);
    expect(retornoPct([100, 110], 1)).toBeCloseTo(10);
  });

  it('MACD positivo em alta e negativo em baixa', () => {
    expect(macd(Array.from({ length: 80 }, (_, i) => 100 * 1.01 ** i))!.linha).toBeGreaterThan(0);
    expect(macd(Array.from({ length: 80 }, (_, i) => 100 * 0.99 ** i))!.linha).toBeLessThan(0);
    expect(macd([1, 2, 3])).toBeNull();
  });

  it('queda máxima e atual', () => {
    expect(quedas([100, 120, 60, 90])).toEqual({ maxima_pct: 50, atual_pct: 25 });
  });

  it('volatilidade zero com retorno constante; ATR em % do preço', () => {
    expect(volatilidadeAnual(Array.from({ length: 40 }, (_, i) => 100 * 1.01 ** i), 30)).toBeCloseTo(0, 6);
    expect(atrPct(velas(Array.from({ length: 30 }, () => 100)))).toBeCloseTo(2, 6);
  });

  it('resumo com força relativa contra o BTC', () => {
    const r = resumoTecnico(velas(Array.from({ length: 220 }, (_, i) => 100 + i)), Array.from({ length: 220 }, () => 50));
    expect(r.media_200d).not.toBeNull();
    expect(r.preco_vs_media_200d_pct).toBeGreaterThan(0);
    expect(r.forca_relativa_vs_btc_30d_pct).toBeGreaterThan(0);
    expect(r.ultimas_5_velas).toHaveLength(5);
  });
});

describe('agentes e nota final', () => {
  const tecnico = AGENTES.find((a) => a.id === 'tecnico')!;
  const risco = AGENTES.find((a) => a.id === 'risco')!;

  it('pesos somam 100%, como no original', () => {
    expect(AGENTES.reduce((t, a) => t + a.peso, 0)).toBeCloseTo(1);
  });

  it('lê o JSON do agente; nota = soma das subnotas; corta fora da régua', () => {
    const r = lerAgente(
      '```json\n{"subnotas":[{"nome":"a","nota":18},{"nome":"b","nota":25},{"nome":"c","nota":-3},{"nome":"d","nota":10}],"sinal":"Alta","resumo":"ok","pontos":["x"],"niveis":{"entrada_min":1,"entrada_max":2,"stop":0.9,"alvo1":3,"alvo2":4}}\n```',
      tecnico,
    );
    // a 5ª subnota faltou: vale 10
    expect(r.subnotas.map((s) => s.nota)).toEqual([18, 20, 0, 10, 10]);
    expect(r.nota).toBe(58);
    expect(r.subnotas[0]!.nome).toBe('Tendência');
    expect(r.niveis).toMatchObject({ stop: 0.9 });
  });

  it('agente sem níveis ignora os que vierem', () => {
    const r = lerAgente('{"subnotas":[{"nome":"a","nota":10}],"sinal":"","resumo":"","pontos":[],"niveis":{"entrada_min":1,"entrada_max":2,"stop":1,"alvo1":3,"alvo2":4}}', risco);
    expect(r.niveis).toBeNull();
  });

  it('resposta sem JSON é erro', () => {
    expect(() => lerAgente('não sei', tecnico)).toThrow();
  });

  it('nota composta refaz os pesos quando um agente falha', () => {
    expect(notaComposta([{ peso: 0.25, nota: 80 }, { peso: 0.25, nota: 60 }, { peso: 0.2, nota: 40 }, { peso: 0.15, nota: 100 }, { peso: 0.15, nota: 20 }])).toBe(61);
    expect(notaComposta([{ peso: 0.25, nota: 80 }, { peso: 0.75, nota: null }])).toBe(80);
    expect(notaComposta([{ peso: 1, nota: null }])).toBeNull();
  });

  it('conceito e sinal pela tabela do original', () => {
    expect(conceito(85)).toEqual({ conceito: 'A+', sinal: 'Compra forte' });
    expect(conceito(70).conceito).toBe('A');
    expect(conceito(55).conceito).toBe('B');
    expect(conceito(40).conceito).toBe('C');
    expect(conceito(25).conceito).toBe('D');
    expect(conceito(24).conceito).toBe('F');
  });
});

describe('trava da análise na estratégia', () => {
  const agora = new Date('2026-10-29T12:00:00Z');
  const est = { analise_nota_min: 60, analise_validade_h: 24 };
  const recente = { nota: 72, terminada_em: new Date('2026-10-29T08:00:00Z') };

  it('sem exigência, ou em venda/zerar, não barra', () => {
    expect(conferirAnalise('comprar', null, { analise_nota_min: null, analise_validade_h: 24 }, agora).ok).toBe(true);
    expect(conferirAnalise('vender', null, est, agora).ok).toBe(true);
    expect(conferirAnalise('zerar', null, est, agora).ok).toBe(true);
  });

  it('compra precisa de análise recente com nota mínima', () => {
    expect(conferirAnalise('comprar', recente, est, agora).ok).toBe(true);
    expect(conferirAnalise('comprar', null, est, agora)).toMatchObject({ ok: false, motivo: expect.stringMatching(/não há análise/) });
    expect(conferirAnalise('comprar', { ...recente, nota: 59 }, est, agora)).toMatchObject({ ok: false, motivo: expect.stringMatching(/abaixo do mínimo/) });
    expect(conferirAnalise('comprar', { ...recente, terminada_em: new Date('2026-10-28T08:00:00Z') }, est, agora)).toMatchObject({ ok: false, motivo: expect.stringMatching(/28 h/) });
  });
});
