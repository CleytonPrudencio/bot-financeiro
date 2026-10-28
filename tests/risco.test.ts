import { describe, expect, it } from 'vitest';
import { avaliar, ipPermitido, type EstadoRisco } from '../src/risco.js';
import type { Sinal } from '../src/sinal.js';

function estado(mudar: Partial<EstadoRisco> = {}, est: Partial<EstadoRisco['estrategia']> = {}): EstadoRisco {
  return {
    paradaGeral: false,
    realNoServidor: false,
    conta: { modo: 'simulacao' },
    estrategia: {
      ativa: true,
      real: false,
      simbolo: 'BTC/USDT',
      valor_ordem: 100,
      limite_por_ordem: 200,
      limite_diario: 500,
      limite_posicao: null,
      intervalo_min_seg: 60,
      desvio_max_pct: 1,
      ips_permitidos: null,
      ...est,
    },
    gastoHoje: 0,
    ultimaOrdemEm: null,
    posicao: { quantidade: 0, custo_total: 0 },
    cotacao: 50_000,
    agora: new Date('2026-10-28T12:00:00Z'),
    ip: '52.89.214.238',
    ...mudar,
  };
}

const comprar: Sinal = { acao: 'comprar' };

describe('avaliar', () => {
  it('compra em simulação com o valor padrão da estratégia', () => {
    expect(avaliar(comprar, estado())).toEqual({ aprovado: true, modo: 'simulacao', lado: 'compra', valor: 100 });
  });

  it('usa o valor do sinal quando vem', () => {
    expect(avaliar({ acao: 'comprar', valor: 150 }, estado())).toMatchObject({ aprovado: true, valor: 150 });
  });

  it('parada geral bloqueia tudo, inclusive zerar', () => {
    const e = estado({ paradaGeral: true, posicao: { quantidade: 1, custo_total: 100 } });
    expect(avaliar(comprar, e)).toMatchObject({ aprovado: false, situacao: 'rejeitado' });
    expect(avaliar({ acao: 'zerar' }, e)).toMatchObject({ aprovado: false });
  });

  it('estratégia desativada rejeita', () => {
    expect(avaliar(comprar, estado({}, { ativa: false }))).toMatchObject({ aprovado: false, motivo: 'estratégia desativada' });
  });

  it('par diferente rejeita; formatos do TradingView batem', () => {
    expect(avaliar({ acao: 'comprar', simbolo: 'ETH/USDT' }, estado())).toMatchObject({ aprovado: false });
    expect(avaliar({ acao: 'comprar', simbolo: 'BTCUSDT' }, estado())).toMatchObject({ aprovado: true });
    expect(avaliar({ acao: 'comprar', simbolo: 'BINANCE:BTCUSDT' }, estado())).toMatchObject({ aprovado: true });
  });

  describe('dinheiro real: as três chaves', () => {
    const real = { real: true };
    it('só servidor + conta + estratégia liberam', () => {
      expect(avaliar(comprar, estado({ realNoServidor: true, conta: { modo: 'real' } }, real))).toMatchObject({ aprovado: true, modo: 'real' });
    });
    it('sem o servidor, rejeita (não cai em simulação calado)', () => {
      expect(avaliar(comprar, estado({ conta: { modo: 'real' } }, real))).toMatchObject({ aprovado: false });
    });
    it('sem a conta real, rejeita', () => {
      expect(avaliar(comprar, estado({ realNoServidor: true }, real))).toMatchObject({ aprovado: false });
    });
    it('estratégia não real opera em simulação mesmo com conta e servidor reais', () => {
      expect(avaliar(comprar, estado({ realNoServidor: true, conta: { modo: 'real' } }))).toMatchObject({ aprovado: true, modo: 'simulacao' });
    });
  });

  it('limite por ordem', () => {
    expect(avaliar({ acao: 'comprar', valor: 201 }, estado())).toMatchObject({ aprovado: false });
    expect(avaliar({ acao: 'comprar', valor: 200 }, estado())).toMatchObject({ aprovado: true });
  });

  it('limite diário conta o que já foi comprado hoje', () => {
    expect(avaliar(comprar, estado({ gastoHoje: 400 }))).toMatchObject({ aprovado: true });
    expect(avaliar(comprar, estado({ gastoHoje: 401 }))).toMatchObject({ aprovado: false });
  });

  it('limite de posição', () => {
    const e = estado({ posicao: { quantidade: 0.01, custo_total: 250 } }, { limite_posicao: 300 });
    expect(avaliar({ acao: 'comprar', valor: 50 }, e)).toMatchObject({ aprovado: true });
    expect(avaliar({ acao: 'comprar', valor: 51 }, e)).toMatchObject({ aprovado: false });
  });

  it('intervalo mínimo entre ordens, menos para zerar', () => {
    const e = estado({ ultimaOrdemEm: new Date('2026-10-28T11:59:30Z'), posicao: { quantidade: 1, custo_total: 100 } });
    expect(avaliar(comprar, e)).toMatchObject({ aprovado: false });
    expect(avaliar({ acao: 'zerar' }, e)).toMatchObject({ aprovado: true, lado: 'venda', quantidade: 1 });
    expect(avaliar(comprar, { ...e, agora: new Date('2026-10-28T12:00:31Z') })).toMatchObject({ aprovado: true });
  });

  it('preço do sinal longe da cotação rejeita', () => {
    expect(avaliar({ acao: 'comprar', preco: 50_400 }, estado())).toMatchObject({ aprovado: true });
    expect(avaliar({ acao: 'comprar', preco: 50_600 }, estado())).toMatchObject({ aprovado: false });
  });

  it('vender sem posição é ignorado', () => {
    expect(avaliar({ acao: 'vender' }, estado())).toMatchObject({ aprovado: false, situacao: 'ignorado' });
  });

  it('vender limita à posição; sem quantidade vende tudo', () => {
    const e = estado({ posicao: { quantidade: 0.5, custo_total: 100 } });
    expect(avaliar({ acao: 'vender', quantidade: 0.2 }, e)).toMatchObject({ aprovado: true, quantidade: 0.2 });
    expect(avaliar({ acao: 'vender', quantidade: 9 }, e)).toMatchObject({ aprovado: true, quantidade: 0.5 });
    expect(avaliar({ acao: 'vender' }, e)).toMatchObject({ aprovado: true, quantidade: 0.5 });
  });

  it('lista de IPs', () => {
    expect(avaliar(comprar, estado({}, { ips_permitidos: '52.89.214.238, 34.212.75.30' }))).toMatchObject({ aprovado: true });
    expect(avaliar(comprar, estado({ ip: '1.2.3.4' }, { ips_permitidos: '52.89.214.238' }))).toMatchObject({ aprovado: false });
  });
});

describe('ipPermitido', () => {
  it('lista vazia libera; IPv4 mapeado em IPv6 bate', () => {
    expect(ipPermitido(null, '')).toBe(true);
    expect(ipPermitido('::ffff:52.89.214.238', '52.89.214.238')).toBe(true);
    expect(ipPermitido(null, '52.89.214.238')).toBe(false);
  });
});
