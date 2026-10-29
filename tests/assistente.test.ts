import { describe, expect, it } from 'vitest';
import { lerGrafico } from '../src/brokers/grafico.js';
import { lerResposta, textoDoAlerta } from '../src/assistente/textos.js';

describe('resposta do dono no Telegram', () => {
  it('lê preço e quantidade em vários jeitos', () => {
    expect(lerResposta('38,10 1')).toEqual({ preco: 38.1, quantidade: 1 });
    expect(lerResposta('R$ 38.10, 2 ações')).toEqual({ preco: 38.1, quantidade: 2 });
    expect(lerResposta('38,1')).toEqual({ preco: 38.1 });
    expect(lerResposta('38,10 1,5')).toEqual({ preco: 38.1 }); // quantidade quebrada não vale (ação é inteira)
    expect(lerResposta('não sei')).toBeNull();
  });
});

describe('texto do aviso', () => {
  it('compra: quantidade, preço, stop e alvo para registrar na XP', () => {
    const t = textoDoAlerta({ lado: 'compra', simbolo: 'PETR4/BRL', quantidade: 2, preco_ref: 38.2, stop: 37.05, alvo: 40.49, motivo: 'virada' });
    expect(t).toContain('COMPRAR 2 ações de PETR4');
    expect(t).toContain('R$ 38,20');
    expect(t).toContain('ordem STOP de venda em R$ 37,05');
    expect(t).toContain('alvo de venda em R$ 40,49');
  });
  it('venda: lembra que o stop da XP pode já ter vendido', () => {
    const t = textoDoAlerta({ lado: 'venda', simbolo: 'VALE3/BRL', quantidade: 1, preco_ref: 61, stop: null, alvo: null, motivo: null });
    expect(t).toContain('VENDER 1 ação de VALE3');
    expect(t).toContain('Já vendi');
  });
});

describe('gráfico do Yahoo', () => {
  it('tira as velas sem negócio e pega o preço atual', () => {
    const g = lerGrafico({ chart: { result: [{ meta: { regularMarketPrice: 10 }, timestamp: [1, 2, 3], indicators: { quote: [{ open: [9, null, 9.5], high: [10, null, 10], low: [8, null, 9], close: [9.5, null, 9.8], volume: [100, null, 50] }] } }], error: null } });
    expect(g.preco).toBe(10);
    expect(g.velas).toEqual([
      { t: 1000, abre: 9, max: 10, min: 8, fecha: 9.5, volume: 100 },
      { t: 3000, abre: 9.5, max: 10, min: 9, fecha: 9.8, volume: 50 },
    ]);
  });
  it('erro do Yahoo vira mensagem', () => {
    expect(() => lerGrafico({ chart: { result: null, error: { description: 'No data found' } } })).toThrow('No data found');
  });
});
