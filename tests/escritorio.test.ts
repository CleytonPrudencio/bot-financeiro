import { describe, expect, it } from 'vitest';
// @ts-expect-error módulo JS do painel, sem tipos
import { analisar, aplicarConselho, decidirJuntos, executar, novaCarteira, verificarChefe, MAX_POSICOES_ABERTAS } from '../public/escritorio/decisao.js';
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

describe('conselho de IAs', () => {
  const aprovado = { aprovado: true, combinada: 0.7, motivo: 'nota conjunta acima do mínimo' };
  const voto = (decisao: string) => ({ ok: true, conector: 'x', parecer: { decisao, confianca: 0.8, motivo: '' } });

  it('maioria de vetos reprova; empate não', () => {
    expect(aplicarConselho(aprovado, [voto('vetar'), voto('vetar'), voto('aprovar')])).toMatchObject({ aprovado: false, motivo: 'conselho de IAs vetou (2 de 3)' });
    expect(aplicarConselho(aprovado, [voto('vetar'), voto('aprovar')]).aprovado).toBe(true);
  });

  it('nunca aprova o que o chefe reprovou; stop não é vetado; sem respostas nada muda', () => {
    const reprovado = { ...aprovado, aprovado: false };
    expect(aplicarConselho(reprovado, [voto('aprovar')]).aprovado).toBe(false);
    expect(aplicarConselho(aprovado, [voto('vetar')], false)).toMatchObject({ aprovado: true, conselho: { vetos: 1 } });
    expect(aplicarConselho(aprovado, undefined)).toBe(aprovado);
    expect(aplicarConselho(aprovado, [{ ok: false }]).aprovado).toBe(true);
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

// @ts-expect-error módulo JS do painel, sem tipos
import { carteiraDa, criarMercadoReal, motivoDoRobo, propostaDoSinal, visualDa } from '../public/escritorio/aovivo.js';

describe('escritório ao vivo', () => {
  const estrategia = {
    id: 4, nome: 'Piloto BTC/BRL (padrão)', simbolo: 'BTC/BRL', exchange: 'binance', ativa: true, auto_ligado: true,
    posicao: 0.0001, custo_posicao: 50, preco: 520_000, abertura_hoje: 500_000,
    fechamentos: Array.from({ length: 80 }, (_, i) => 400_000 + i * 1000),
  };

  it('cada estratégia vira um ativo com preço real, variação do dia e médias', () => {
    const m = criarMercadoReal({ estrategias: [estrategia] });
    const a = m.ativos[0];
    expect(a).toMatchObject({ estrategiaId: 4, simbolo: 'BTC/BRL', moeda: 'R$', preco: 520_000, semCotacao: false });
    expect(a.variacaoDia).toBeCloseTo(0.04);
    expect(a.historico).toHaveLength(81);
    expect(a.medias[60].at(-1)).not.toBeNull();
    // sem cotação agora: fica a última conhecida
    m.atualizar({ estrategias: [{ ...estrategia, preco: null }] });
    expect(m.ativos[0].preco).toBe(520_000);
    expect(visualDa('BTC/BRL').simbolo).toBe('₿');
    expect(carteiraDa(estrategia, {}).precoEntrada).toBeCloseTo(500_000);
  });

  it('a reunião encena o que o bot decidiu: agente barrou', () => {
    const ativo = criarMercadoReal({ estrategias: [estrategia] }).ativos[0];
    const p = propostaDoSinal({
      id: 7, acao: 'comprar', situacao: 'rejeitado', motivo: 'IA barrou: 0 aprovaram, 1 vetaram', ip: 'piloto',
      id_externo: 'piloto-entrada-123', recebido_em: '2026-10-29T18:00:00Z', ordem: null, pareceres: [],
      agente: { confianca: 0.7, etapas: { tecnica: { ok: true, resultado: { vies: 'contra', nota: 33 } }, previsao: { ok: true, resultado: { vies: 'contra', nota: 13 } } } },
    }, ativo);
    expect(p).toMatchObject({ real: true, lado: 'compra', motivo: 'virada para alta (piloto)', decisao: { aprovado: false } });
    expect(p.verificacao.itens.map((i: { texto: string }) => i.texto)).toEqual([
      'Origem: Piloto automático', 'Kronos: contra (13/100)', 'Técnica: contra (33/100)', 'Barrado: IA barrou: 0 aprovaram, 1 veta…', // cortado para caber no holograma
    ]);
    expect(p.falaChefe).toContain('Não agora');
  });

  it('ordem executada: aprovado, com o modo e o preço da ordem', () => {
    const ativo = criarMercadoReal({ estrategias: [estrategia] }).ativos[0];
    const p = propostaDoSinal({
      id: 8, acao: 'zerar', situacao: 'executado', motivo: null, ip: 'piloto', id_externo: 'piloto-stop-1',
      recebido_em: '2026-10-29T18:00:00Z', agente: null, pareceres: [], ordem: { lado: 'venda', modo: 'real', preco: 504_400, custo: 50 },
    }, ativo);
    expect(p).toMatchObject({ lado: 'venda', urgente: true, preco: 504_400, motivo: 'stop de perda (piloto)', decisao: { aprovado: true, motivo: 'ordem REAL executada' } });
  });
});

describe('escritório ao vivo: olheiros da varredura', () => {
  it('um robô por par que o piloto olha, com o motivo de cada um', () => {
    const e = {
      id: 9, nome: 'Piloto', simbolo: 'BTC/BRL', exchange: 'binance', ativa: true, auto_ligado: true, auto_varrer: true,
      auto_situacao: 'olhou 2 pares', motivo_par: 'média de 50 abaixo da de 200', posicao: 0, custo_posicao: 0, preco: 400_000, fechamentos: [],
      pares: [{ simbolo: 'ETH/BRL', preco: 20_000, variacao_pct: 2.5, motivo: 'MACD sem força', virou: false, fechamentos: [19_000, 19_500] }],
    };
    const m = criarMercadoReal({ estrategias: [e] });
    expect(m.ativos.map((a: { id: string }) => a.id)).toEqual(['e9', 'e9:ETH/BRL']);
    const [principal, olheiro] = m.ativos;
    expect(olheiro).toMatchObject({ olheiro: true, simbolo: 'ETH/BRL', nome: 'Olheiro ETH', preco: 20_000 });
    expect(olheiro.variacaoDia).toBeCloseTo(0.025);
    expect(motivoDoRobo(olheiro)).toBe('MACD sem força');
    expect(motivoDoRobo(principal)).toBe('média de 50 abaixo da de 200');
    // a estratégia trocou de par: o robô principal acompanha; o olheiro fica no par dele
    m.atualizar({ estrategias: [{ ...e, simbolo: 'ETH/BRL', pares: [] }] });
    expect(m.ativos[0].simbolo).toBe('ETH/BRL');
    expect(m.ativos[1].simbolo).toBe('ETH/BRL');
  });
});

// @ts-expect-error módulo JS do painel, sem tipos
import * as Desenho from '../public/escritorio/desenho.js';

describe('mesas do escritório', () => {
  it('8 mesas no mínimo; mais robôs, mais fileiras de 4 e o escritório fica mais alto', () => {
    expect(Desenho.configurarMesas(3)).toBe(8);
    expect(Desenho.ALTURA).toBe(720);
    expect(Desenho.configurarMesas(13)).toBe(16);
    expect(Desenho.VAGAS_MESA.at(-1)).toMatchObject({ y: 480 + 3 * 185 });
    expect(Desenho.ALTURA).toBe(480 + 3 * 185 + 55);
    // a perspectiva para de crescer nas fileiras extras
    expect(Desenho.escalaEm(1000)).toBe(1.12);
    Desenho.configurarMesas(8);
  });
});

// @ts-expect-error módulo JS do painel, sem tipos
import { situacaoCurta } from '../public/escritorio/aovivo.js';

describe('situação curta no quadro do escritório', () => {
  it('resume o motivo do piloto em poucas palavras', () => {
    expect(situacaoCurta('olhou 1 par em velas de 1m: nenhum está para alta agora. BTC/BRL: preço abaixo da média de 200 velas; MACD sem força')).toEqual(['em queda', 'perigo']);
    expect(situacaoCurta('barrado ou stop há pouco: descansa 6 h')).toEqual(['descansando', 'neutro']);
    expect(situacaoCurta('ETH/BRL: virou, mas tendência diária contra (preço abaixo da média de 50 dias)')).toEqual(['dia contra', 'alerta']);
    expect(situacaoCurta('PEPE/BRL: tendência de alta em curso: preço acima… → executado')).toEqual(['comprou', 'ok']);
    expect(situacaoCurta('qualquer coisa', { temPosicao: true, variacaoPosicao: 0.0123 })).toEqual(['posição +1.23%', 'ok']);
    expect(situacaoCurta('x', { ativa: false })).toEqual(['parada', 'neutro']);
    expect(situacaoCurta(null, { olheiro: true })).toEqual(['de olho', 'neutro']);
    expect(situacaoCurta('BTC/BRL: vendido demais (IFR 24), esperando a vela de volta')).toEqual(['vendido, esperando', 'alerta']);
    expect(situacaoCurta('BTC/BRL: repique: IFR saiu de 24 (vendido demais) e a vela fechou em alta; Kronos 61% de alta')).toEqual(['sinal de repique', 'ok']);
  });
});
