import { describe, expect, it } from 'vitest';
import type { Vela } from '../src/analise/indicadores.js';
import { lerRepique, lerSinal, lerTendencia, payoutDoPrazo, perdasSeguidas, VELA_MS, velasQuotex } from '../src/binarias/regras.js';
import { acertoParaEmpatar, avaliarAposta, lucroDaAposta, type EstadoAposta } from '../src/risco.js';

const T0 = Date.UTC(2026, 9, 30, 12);

/** Velas de 1 min: cada uma abre no fechamento da anterior e fecha no valor dado. */
function velas(fechamentos: number[]): Vela[] {
  return fechamentos.map((f, i) => {
    const abre = i === 0 ? f : fechamentos[i - 1]!;
    return { t: T0 + i * VELA_MS, abre, max: Math.max(abre, f) + 0.01, min: Math.min(abre, f) - 0.01, fecha: f, volume: 0 };
  });
}

const queda = (n: number) => Array.from({ length: n }, (_, i) => 100 - i * 0.1 + (i % 2 ? 0.02 : 0));
const subida = (n: number) => Array.from({ length: n }, (_, i) => 100 + i * 0.1 - (i % 2 ? 0.02 : 0));
/** alta com recuos (sobe 1, volta 0,6) que acelera no fim (sobe 1,3): IFR perto de 65, MACD positivo, termina numa vela de alta */
const altaComRecuos = (n: number) => {
  const v = [100];
  for (let i = 1; i < n; i++) v.push(v[i - 1]! + (i % 2 ? (i > n - 20 ? 1.3 : 1) : -0.6));
  return v;
};

describe('velas da ponte Quotex', () => {
  it('converte, ordena, tira repetidas e a vela ainda aberta', () => {
    const linhas = [[T0 + VELA_MS, 2, 3, 1, 2.5], [T0, 1, 2, 0.5, 1.5], [T0, 1, 2, 0.5, 1.5], [T0 + 2 * VELA_MS, 2.5, 3, 2, 2.8], ['x'], null];
    const v = velasQuotex(linhas, T0 + 2 * VELA_MS + 30_000);
    expect(v.map((x) => x.fecha)).toEqual([1.5, 2.5]);
    expect(velasQuotex('lixo', T0)).toEqual([]);
  });
});

describe('sinal do repique', () => {
  it('poucas velas: não aposta', () => {
    expect(lerRepique(velas(queda(30))).direcao).toBeNull();
  });
  it('vendido demais e a vela fechou verde: CALL', () => {
    const f = queda(80);
    f.push(f[f.length - 1]! + 0.3);
    expect(lerRepique(velas(f))).toMatchObject({ direcao: 'call' });
  });
  it('vendido demais e ainda caindo: espera', () => {
    expect(lerRepique(velas(queda(81)))).toMatchObject({ direcao: null, motivo: expect.stringContaining('esperando') });
  });
  it('comprado demais e a vela fechou vermelha: PUT', () => {
    const f = subida(80);
    f.push(f[f.length - 1]! - 0.3);
    expect(lerRepique(velas(f))).toMatchObject({ direcao: 'put' });
  });
  it('sem exagero: não aposta', () => {
    expect(lerRepique(velas(altaComRecuos(80))).direcao).toBeNull();
  });
});

describe('sinal da tendência', () => {
  it('alta com recuos e vela verde: CALL', () => {
    expect(lerTendencia(velas(altaComRecuos(80)))).toMatchObject({ direcao: 'call' });
    expect(lerSinal(velas(altaComRecuos(80)), 'tendencia').direcao).toBe('call');
  });
  it('o espelho (baixa com repiques e vela vermelha): PUT', () => {
    expect(lerTendencia(velas(altaComRecuos(80).map((x) => 300 - x)))).toMatchObject({ direcao: 'put' });
  });
  it('alta sem recuo nenhum (IFR esticado): não aposta', () => {
    expect(lerTendencia(velas(Array.from({ length: 81 }, (_, i) => 100 + i))).direcao).toBeNull();
  });
});

describe('ajudantes', () => {
  it('payout do prazo', () => {
    expect(payoutDoPrazo(60, 80, 85)).toBe(80);
    expect(payoutDoPrazo(180, 80, 85)).toBe(80);
    expect(payoutDoPrazo(300, 80, 85)).toBe(85);
  });
  it('perdas seguidas na ponta', () => {
    expect(perdasSeguidas(['perdeu', 'perdeu', 'ganhou', 'perdeu'])).toBe(2);
    expect(perdasSeguidas(['perdeu', 'empate', 'perdeu'])).toBe(2);
    expect(perdasSeguidas(['ganhou', 'perdeu'])).toBe(0);
    expect(perdasSeguidas([])).toBe(0);
  });
});

// ------------------------------------------------------------------ risco da aposta

function estado(mudar: Partial<EstadoAposta> = {}, b: Partial<EstadoAposta['binaria']> = {}): EstadoAposta {
  return {
    paradaGeral: false,
    realNoServidor: false,
    conta: { modo: 'simulacao' },
    binaria: { ativa: true, real: false, valor: 5, payout_min: 85, max_apostas_dia: 10, perda_max_dia: 15, perdas_seguidas_max: 3, intervalo_min_seg: 300, ...b },
    ponteOnline: true,
    ponteConta: 'demo',
    ativo: { aberto: true, payout: 88 },
    saldo: 10_000,
    apostasHoje: 0,
    perdaHoje: 0,
    perdasSeguidas: 0,
    emAndamento: false,
    ultimaApostaEm: null,
    agora: new Date('2026-10-30T15:00:00Z'),
    ...mudar,
  };
}

describe('avaliarAposta', () => {
  it('tudo certo: aposta na demo, com o valor fixo da estratégia', () => {
    expect(avaliarAposta(estado())).toEqual({ aprovado: true, modo: 'simulacao', valor: 5, payout: 88 });
  });
  it('parada geral e estratégia desligada barram', () => {
    expect(avaliarAposta(estado({ paradaGeral: true }))).toMatchObject({ aprovado: false });
    expect(avaliarAposta(estado({}, { ativa: false }))).toMatchObject({ aprovado: false });
  });

  describe('dinheiro real: as três chaves e a ponte na conta real', () => {
    const real = { realNoServidor: true, conta: { modo: 'real' as const }, ponteConta: 'real' as const };
    it('com tudo ligado, aposta real', () => {
      expect(avaliarAposta(estado(real, { real: true }))).toMatchObject({ aprovado: true, modo: 'real' });
    });
    it('sem BOT_LIVE_ENABLED: rejeita (não cai na demo calado)', () => {
      expect(avaliarAposta(estado({ ...real, realNoServidor: false }, { real: true }))).toMatchObject({ aprovado: false, motivo: expect.stringContaining('BOT_LIVE_ENABLED') });
    });
    it('conta em demo: rejeita', () => {
      expect(avaliarAposta(estado({ ...real, conta: { modo: 'simulacao' } }, { real: true }))).toMatchObject({ aprovado: false });
    });
    it('ponte na demo com estratégia real: rejeita', () => {
      expect(avaliarAposta(estado({ ...real, ponteConta: 'demo' }, { real: true }))).toMatchObject({ aprovado: false, motivo: expect.stringContaining('PONTE_CONTA=real') });
    });
    it('ponte na real com estratégia em simulação: rejeita (simulação só na demo)', () => {
      expect(avaliarAposta(estado({ ponteConta: 'real' }))).toMatchObject({ aprovado: false });
      expect(avaliarAposta(estado({ ponteConta: null }))).toMatchObject({ aprovado: false });
    });
  });

  it('uma por vez', () => {
    expect(avaliarAposta(estado({ emAndamento: true }))).toMatchObject({ aprovado: false, situacao: 'ignorado' });
  });
  it('ponte desligada, ativo ausente, fechado ou sem payout', () => {
    expect(avaliarAposta(estado({ ponteOnline: false }))).toMatchObject({ aprovado: false });
    expect(avaliarAposta(estado({ ativo: null }))).toMatchObject({ aprovado: false });
    expect(avaliarAposta(estado({ ativo: { aberto: false, payout: 90 } }))).toMatchObject({ aprovado: false });
    expect(avaliarAposta(estado({ ativo: { aberto: true, payout: null } }))).toMatchObject({ aprovado: false });
  });
  it('payout abaixo do mínimo, dizendo quanto teria de acertar', () => {
    expect(avaliarAposta(estado({ ativo: { aberto: true, payout: 70 } }))).toMatchObject({ aprovado: false, motivo: expect.stringContaining('58.8%') });
  });
  it('intervalo mínimo entre apostas', () => {
    const r = avaliarAposta(estado({ ultimaApostaEm: new Date('2026-10-30T14:58:00Z') }));
    expect(r).toMatchObject({ aprovado: false, motivo: expect.stringContaining('faltam 180 s') });
    expect(avaliarAposta(estado({ ultimaApostaEm: new Date('2026-10-30T14:54:00Z') }))).toMatchObject({ aprovado: true });
  });
  it('teto de apostas no dia', () => {
    expect(avaliarAposta(estado({ apostasHoje: 10 }))).toMatchObject({ aprovado: false });
    expect(avaliarAposta(estado({ apostasHoje: 9 }))).toMatchObject({ aprovado: true });
  });
  it('perdas seguidas param o dia', () => {
    expect(avaliarAposta(estado({ perdasSeguidas: 3 }))).toMatchObject({ aprovado: false, motivo: expect.stringContaining('parou por hoje') });
  });
  it('perda máxima do dia conta a próxima aposta inteira', () => {
    expect(avaliarAposta(estado({ perdaHoje: 10 }))).toMatchObject({ aprovado: true });
    expect(avaliarAposta(estado({ perdaHoje: 10.01 }))).toMatchObject({ aprovado: false });
  });
  it('saldo que não cobre a aposta', () => {
    expect(avaliarAposta(estado({ saldo: 4.99 }))).toMatchObject({ aprovado: false });
    expect(avaliarAposta(estado({ saldo: null }))).toMatchObject({ aprovado: true });
  });
  it('nunca muda o valor da aposta (sem martingale)', () => {
    const r = avaliarAposta(estado({ perdasSeguidas: 2, perdaHoje: 10 }));
    expect(r).toMatchObject({ aprovado: true, valor: 5 });
  });
});

describe('contas da binária', () => {
  it('taxa de acerto para empatar', () => {
    expect(acertoParaEmpatar(85)).toBeCloseTo(54.05, 2);
    expect(acertoParaEmpatar(100)).toBe(50);
  });
  it('lucro líquido pelo resultado', () => {
    expect(lucroDaAposta('ganhou', 5, 88)).toBe(4.4);
    expect(lucroDaAposta('perdeu', 5, 88)).toBe(-5);
    expect(lucroDaAposta('empate', 5, 88)).toBe(0);
  });
});
