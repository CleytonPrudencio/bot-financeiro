import { describe, expect, it } from 'vitest';
import { operacoesFechadas, porDia, resumoDoResultado, saldoDaConta, type OrdemExecutada } from '../src/resultado.js';

const o = (lado: 'compra' | 'venda', quantidade: number, custo: number, taxa: number, criada_em: string, mudar: Partial<OrdemExecutada> = {}): OrdemExecutada => ({
  estrategia_id: 1, estrategia: 'Piloto PEPE', simbolo: 'PEPE/BRL', lado, modo: 'real', quantidade, custo, taxa, criada_em, ...mudar,
});

describe('ganho e perda das operações', () => {
  it('a operação da PEPE: compra de 50, venda de 49,42 com taxa de 0,05', () => {
    const ops = operacoesFechadas([o('compra', 1_753_861.38, 50, 0.05, '2026-11-04T16:30:24Z'), o('venda', 1_753_861, 49.42, 0.05, '2026-11-04T16:32:54Z')]);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.resultado).toBeCloseTo(49.37 - 50 * (1_753_861 / 1_753_861.38), 6);
    expect(ops[0]!.resultado_pct).toBeCloseTo(-1.26, 1);
    expect(ops[0]!.moeda).toBe('BRL');
  });
  it('preço médio: duas compras e uma venda parcial', () => {
    const ops = operacoesFechadas([o('compra', 1, 100, 0, '2026-11-01T10:00:00Z'), o('compra', 1, 120, 0, '2026-11-01T11:00:00Z'), o('venda', 1, 130, 1, '2026-11-01T12:00:00Z')]);
    expect(ops[0]!.resultado).toBeCloseTo(130 - 1 - 110, 6);
  });
  it('venda sem compra antes (de fora do bot) não vira operação; estratégias e modos não se misturam', () => {
    expect(operacoesFechadas([o('venda', 1, 10, 0, '2026-11-01T10:00:00Z')])).toEqual([]);
    const ops = operacoesFechadas([
      o('compra', 1, 10, 0, '2026-11-01T10:00:00Z'),
      o('compra', 1, 10, 0, '2026-11-01T10:00:00Z', { estrategia_id: 2, modo: 'simulacao' }),
      o('venda', 1, 12, 0, '2026-11-01T11:00:00Z', { estrategia_id: 2, modo: 'simulacao' }),
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.modo).toBe('simulacao');
  });
  it('por dia no fuso de São Paulo, com acumulado; e o resumo', () => {
    const ops = operacoesFechadas([
      o('compra', 1, 100, 0, '2026-11-03T13:00:00Z'), o('venda', 1, 103, 0, '2026-11-03T14:00:00Z'),
      o('compra', 1, 100, 0, '2026-11-04T13:00:00Z'), o('venda', 1, 99, 0, '2026-11-05T01:00:00Z'), // 22h de 04/11 em São Paulo
    ]);
    const dias = porDia(ops, new Date('2026-11-05T12:00:00Z'), 'America/Sao_Paulo', 3);
    expect(dias.map((d) => [d.dia, d.resultado, d.acumulado])).toEqual([['2026-11-03', 3, 3], ['2026-11-04', -1, 2], ['2026-11-05', 0, 2]]);
    const r = resumoDoResultado(ops, new Date('2026-11-05T02:00:00Z'), 'America/Sao_Paulo');
    expect(r).toMatchObject({ total: 2, hoje: -1, operacoes: 2, ganhas: 1, perdidas: 1, acerto_pct: 50, maior_ganho: 3, maior_perda: -1 });
  });
});

describe('saldo a partir do que o dono colocou', () => {
  it('tinha 50: perdeu 0,63 na PEPE e tem uma posição aberta valendo 0,20 a mais', () => {
    const ops = operacoesFechadas([o('compra', 100, 50, 0, '2026-11-04T16:30:00Z'), o('venda', 100, 49.42, 0.05, '2026-11-04T16:32:00Z')]);
    const s = saldoDaConta(50, ops, 0.2, new Date('2026-11-04T20:00:00Z'), 'America/Sao_Paulo', 3);
    expect(s.realizado).toBeCloseTo(-0.63, 6);
    expect(s.saldo).toBeCloseTo(49.57, 6);
    expect(s.variacao_pct).toBeCloseTo(-0.86, 2);
    expect(s.serie.map((x) => x.dia)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
    expect(s.serie[0]!.saldo).toBe(50);
    expect(s.serie[2]!.saldo).toBeCloseTo(49.57, 6); // o último ponto já soma o aberto
  });
});
