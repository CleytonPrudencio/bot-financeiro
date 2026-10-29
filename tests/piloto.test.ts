import { describe, expect, it } from 'vitest';
import type { Vela } from '../src/analise/indicadores.js';
import { avaliarEntrada, DIA_MS, faltas, ler, tendenciaQuebrou, velasFechadas } from '../src/piloto/regras.js';

const T0 = Date.UTC(2026, 0, 1);
const velas = (fechamentos: number[]): Vela[] =>
  fechamentos.map((f, i) => ({ t: T0 + i * DIA_MS, abre: f, max: f * 1.01, min: f * 0.99, fecha: f, volume: 1 }));

/** 240 dias de alta lenta, um tombo de 12 dias e a retomada: a virada acontece na retomada. */
function serieComVirada(): number[] {
  const v: number[] = [];
  for (let i = 0; i < 240; i++) v.push(100 + i * 0.3);
  for (let i = 0; i < 12; i++) v.push(v[v.length - 1]! * 0.985);
  for (let i = 0; i < 30; i++) v.push(v[v.length - 1]! * 1.006);
  return v;
}

describe('velas fechadas', () => {
  it('tira a vela de hoje, que ainda está aberta', () => {
    const v = velas([1, 2, 3]);
    expect(velasFechadas(v, T0 + 2 * DIA_MS + 3600_000).map((x) => x.fecha)).toEqual([1, 2]);
    expect(velasFechadas(v, T0 + 3 * DIA_MS).map((x) => x.fecha)).toEqual([1, 2, 3]);
  });
});

describe('entrada do piloto', () => {
  it('poucas velas: não entra', () => {
    expect(avaliarEntrada(velas(Array(150).fill(100)))).toMatchObject({ comprar: false });
  });

  it('em queda (abaixo da média de 200): não entra e diz o que falta', () => {
    const queda = Array.from({ length: 260 }, (_, i) => 300 - i * 0.5);
    const r = avaliarEntrada(velas(queda));
    expect(r.comprar).toBe(false);
    expect(r.motivo).toContain('abaixo da média de 200');
  });

  it('compra só no dia da virada, não nos dias seguintes', () => {
    const s = serieComVirada();
    const dias = [];
    for (let n = 202; n <= s.length; n++) if (avaliarEntrada(velas(s.slice(0, n))).comprar) dias.push(n);
    expect(dias.length).toBeGreaterThanOrEqual(1);
    // cada dia de compra é uma virada: no dia anterior a condição não estava cumprida
    for (const n of dias) {
      expect(faltas(ler(s.slice(0, n))!)).toEqual([]);
      expect(faltas(ler(s.slice(0, n - 1))!).length).toBeGreaterThan(0);
    }
    // e não compra em dois dias seguidos
    for (let i = 1; i < dias.length; i++) expect(dias[i]! - dias[i - 1]!).toBeGreaterThan(1);
  });

  it('IFR esticado (alta forte demais) entra na lista do que falta', () => {
    const l = { fechamento: 120, media20: 110, media50: 105, media200: 100, ifr: 82, histograma: 1 };
    expect(faltas(l)).toEqual(['IFR esticado (82)']);
  });
});

describe('saída por tendência', () => {
  it('fechamento abaixo da média de 50 dias', () => {
    const alta = Array.from({ length: 60 }, (_, i) => 100 + i);
    expect(tendenciaQuebrou(velas(alta))).toBeNull();
    expect(tendenciaQuebrou(velas([...alta, 100]))).toContain('média de 50');
  });
});

describe('entrada em tendência já em curso', () => {
  it('sem exigir a virada, entra numa alta que já vinha da vela anterior; com, espera', () => {
    const s = serieComVirada();
    let n = 202;
    while (!avaliarEntrada(velas(s.slice(0, n))).comprar) n++;
    // uma vela depois da virada: a alta continua
    const depois = velas(s.slice(0, n + 1));
    expect(faltas(ler(s.slice(0, n + 1))!)).toEqual([]);
    expect(avaliarEntrada(depois)).toMatchObject({ comprar: false, motivo: expect.stringContaining('espera a próxima virada') });
    expect(avaliarEntrada(depois, { exigirVirada: false })).toMatchObject({ comprar: true, motivo: expect.stringContaining('tendência de alta em curso') });
  });
  it('as outras regras continuam valendo sem a virada', () => {
    const queda = Array.from({ length: 260 }, (_, i) => 300 - i * 0.5);
    expect(avaliarEntrada(velas(queda), { exigirVirada: false }).comprar).toBe(false);
  });
});
