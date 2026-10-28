import { describe, expect, it } from 'vitest';
// @ts-expect-error módulo JS do painel, sem tipos
import { analisar, decidirJuntos, executar, novaCarteira, verificarChefe, MAX_POSICOES_ABERTAS } from '../public/escritorio/decisao.js';
// @ts-expect-error módulo JS do painel, sem tipos
import { calcularMedias, criarMercadoFicticio, ifr, media } from '../public/escritorio/mercado.js';

function ativoCom(serie: number[], volDia = 0.03) {
  const a = { id: 'x', simbolo: 'X/USDT', historico: serie, preco: serie[serie.length - 1], volDia, sigma: volDia / Math.sqrt(390) };
  calcularMedias(a);
  return a;
}

/** Série que cai e depois sobe com recuos (IFR moderado): a média 9 cruza a 26 no último ponto. */
function serieComCruzamentoParaCima(): number[] {
  const s: number[] = [];
  for (let i = 0; i < 80; i++) s.push(100 - i * 0.05 + (i % 2 ? 0.2 : -0.2));
  for (let p = s[s.length - 1]!, i = 0; ; i++) {
    p += i % 2 ? -0.3 : 0.5;
    s.push(p);
    const curta = media(s, 9);
    const longa = media(s, 26);
    const curtaAntes = media(s.slice(0, -1), 9);
    const longaAntes = media(s.slice(0, -1), 26);
    if (curtaAntes <= longaAntes && curta > longa) return s;
    if (s.length > 400) throw new Error('não cruzou');
  }
}

describe('indicadores', () => {
  it('médias e IFR', () => {
    expect(media([1, 2, 3, 4], 2)).toBe(3.5);
    expect(media([1], 2)).toBeNull();
    expect(ifr(Array.from({ length: 20 }, (_, i) => i))).toBe(100);
  });
  it('séries de média alinhadas ao histórico', () => {
    const a = ativoCom([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(a.medias[9][7]).toBeNull();
    expect(a.medias[9][8]).toBe(5);
    expect(a.medias[9][9]).toBe(6);
  });
});

describe('analista', () => {
  it('propõe compra no cruzamento para cima sem posição', () => {
    const a = ativoCom(serieComCruzamentoParaCima());
    const p = analisar(a, novaCarteira());
    expect(p).toMatchObject({ lado: 'compra' });
    expect(p.confianca).toBeGreaterThan(0.5);
    expect(p.confianca).toBeLessThanOrEqual(0.97);
  });

  it('com posição, propõe venda no stop', () => {
    const a = ativoCom(Array.from({ length: 100 }, () => 100), 0.03);
    const c = { ...novaCarteira(), quantidade: 10, precoEntrada: 102 };
    expect(analisar(a, c)).toMatchObject({ lado: 'venda', urgente: true });
  });

  it('sem histórico suficiente, não propõe nada', () => {
    expect(analisar(ativoCom([1, 2, 3]), novaCarteira())).toBeNull();
  });
});

describe('chefe e decisão conjunta', () => {
  it('veta compra quando o escritório já tem o máximo de posições', () => {
    const a = ativoCom(serieComCruzamentoParaCima());
    const p = analisar(a, novaCarteira());
    const v = verificarChefe(p, a, novaCarteira(), MAX_POSICOES_ABERTAS);
    const d = decidirJuntos({ ...p, confianca: 0.99 }, v);
    expect(d.aprovado).toBe(false);
    expect(d.motivo).toMatch(/^veto/);
  });

  it('stop é aprovado mesmo com confiança e nota normais', () => {
    const a = ativoCom(Array.from({ length: 100 }, () => 100));
    const c = { ...novaCarteira(), quantidade: 10, precoEntrada: 102 };
    const p = analisar(a, c);
    const d = decidirJuntos(p, verificarChefe(p, a, c, 1));
    expect(d.aprovado).toBe(true);
  });

  it('nota conjunta pesa 45% o analista e 55% o chefe', () => {
    const d = decidirJuntos({ confianca: 1 }, { itens: [{ ok: false }], nota: 0 });
    expect(d.combinada).toBeCloseTo(0.45);
    expect(d.aprovado).toBe(false);
  });
});

describe('carteira', () => {
  it('compra e venda com lucro e prejuízo; sequência de perdas', () => {
    const c = novaCarteira();
    executar(c, 'compra', 100);
    expect(c.quantidade).toBeCloseTo(10);
    expect(executar(c, 'venda', 110).resultado).toBeCloseTo(100);
    expect(c.perdasSeguidas).toBe(0);
    executar(c, 'compra', 100);
    expect(executar(c, 'venda', 90).resultado).toBeCloseTo(-100);
    executar(c, 'compra', 100);
    executar(c, 'venda', 95);
    expect(c.perdasSeguidas).toBe(2);
    expect(c.resultado).toBeCloseTo(-50);
  });
});

describe('mercado fictício', () => {
  it('mesma semente, mesmos preços; B3 fecha à noite', () => {
    const a = criarMercadoFicticio(123);
    const b = criarMercadoFicticio(123);
    for (let i = 0; i < 50; i++) {
      a.avancar();
      b.avancar();
    }
    expect(a.ativos.map((x: { preco: number }) => x.preco)).toEqual(b.ativos.map((x: { preco: number }) => x.preco));
    const acoes = a.ativos.find((x: { id: string }) => x.id === 'acoes');
    while (a.horaTexto() !== '18:00') a.avancar();
    expect(a.aberto(acoes)).toBe(false);
    expect(a.aberto(a.ativos.find((x: { id: string }) => x.id === 'btc'))).toBe(true);
  });
});
