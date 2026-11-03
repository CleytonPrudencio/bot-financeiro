import { describe, expect, it } from 'vitest';
import { agrupar, grupoDaSituacao } from '../src/diagnostico.js';

const e = (auto_situacao: string | null, mudar: Partial<{ ativa: boolean; auto_ligado: boolean; posicao: number }> = {}) => ({
  ativa: true, auto_ligado: true, posicao: 0, auto_situacao, ...mudar,
});

describe('por que não está comprando', () => {
  it('estado da estratégia vem antes do texto do piloto', () => {
    expect(grupoDaSituacao(e('qualquer', { ativa: false }))).toBe('parada');
    expect(grupoDaSituacao(e(null, { auto_ligado: false }))).toBe('manual');
    expect(grupoDaSituacao(e('x', { posicao: 2 }))).toBe('posicao');
    expect(grupoDaSituacao(e(null))).toBe('aguardando');
  });
  it('lê os textos que o piloto grava', () => {
    expect(grupoDaSituacao(e('B3 fechada: o piloto volta a olhar as ações no pregão'))).toBe('bolsa_fechada');
    expect(grupoDaSituacao(e('já consultou a IA 2 vez(es) hoje, o limite da estratégia'))).toBe('limite_ia');
    expect(grupoDaSituacao(e('PETR4/BRL: repique, mas não há saldo livre para comprar'))).toBe('sem_saldo');
    expect(grupoDaSituacao(e('PETR4/BRL: repique → executado'))).toBe('comprou');
    expect(grupoDaSituacao(e('PETR4/BRL: repique → rejeitado: IA barrou: 0 aprovaram, 1 vetaram'))).toBe('ia_vetou');
    expect(grupoDaSituacao(e('PETR4/BRL: repique → rejeitado: limite diário: já comprou 90'))).toBe('risco_barrou');
    expect(grupoDaSituacao(e('PETR4/BRL: repique → erro: MT5: mercado fechado'))).toBe('erro_ordem');
    expect(grupoDaSituacao(e('falhou nesta passada: a ponte MT5 ainda não mandou velas'))).toBe('erro_piloto');
    expect(grupoDaSituacao(e('olhou 1 par em velas de 1m: nenhum está para alta agora. IVVB11/BRL: entraria, mas 1 ação custa R$ 470.00'))).toBe('acao_cara');
    expect(grupoDaSituacao(e('olhou 1 par em velas de 1m: nenhum está para alta agora. PETR4/BRL: sem repique'))).toBe('sem_sinal');
    expect(grupoDaSituacao(e('texto novo'))).toBe('outro');
  });
  it('agrupa do maior para o menor, com exemplos', () => {
    const g = agrupar([
      { nome: 'A', ...e('B3 fechada') }, { nome: 'B', ...e('B3 fechada') }, { nome: 'C', ...e(null, { ativa: false }) },
    ]);
    expect(g.map((x) => [x.grupo, x.n])).toEqual([['bolsa_fechada', 2], ['parada', 1]]);
    expect(g[0]!.exemplos.map((x) => x.nome)).toEqual(['A', 'B']);
  });
});
