import { describe, expect, it } from 'vitest';
import { avaliar, conferirSaida, consultaIa, decidirComIa, deveAvisarStop, ipPermitido, PISO_PROTECAO, stopSugerido, type EstadoRisco, type PoliticaIa } from '../src/risco.js';
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

describe('parecer das IAs', () => {
  const politica = (p: Partial<PoliticaIa> = {}): PoliticaIa => ({
    modo: 'obrigatorio', quorum: null, falha: 'reprova', confiancaMin: 0.6, nasVendas: false, ...p,
  });
  const sim = (confianca = 0.8) => ({ ok: true as const, decisao: 'aprovar' as const, confianca });
  const nao = (confianca = 0.8) => ({ ok: true as const, decisao: 'vetar' as const, confianca });
  const falhou = { ok: false as const };

  it('só compras passam pela IA, a não ser que a estratégia peça vendas também; zerar nunca', () => {
    expect(consultaIa('comprar', politica())).toBe(true);
    expect(consultaIa('vender', politica())).toBe(false);
    expect(consultaIa('vender', politica({ nasVendas: true }))).toBe(true);
    expect(consultaIa('zerar', politica({ nasVendas: true }))).toBe(false);
    expect(consultaIa('comprar', politica({ modo: 'desligado' }))).toBe(false);
  });

  it('sem quorum, precisa de todas', () => {
    expect(decidirComIa([sim(), sim()], politica()).aprovado).toBe(true);
    expect(decidirComIa([sim(), nao()], politica()).aprovado).toBe(false);
  });

  it('quorum: maioria basta', () => {
    expect(decidirComIa([sim(), sim(), nao()], politica({ quorum: 2 })).aprovado).toBe(true);
    expect(decidirComIa([sim(), nao(), nao()], politica({ quorum: 2 })).aprovado).toBe(false);
  });

  it('aprovação com pouca confiança não conta', () => {
    expect(decidirComIa([sim(0.5)], politica()).aprovado).toBe(false);
    expect(decidirComIa([sim(0.6)], politica()).aprovado).toBe(true);
  });

  it('falha: "reprova" conta como não aprovou; "ignora" tira da conta', () => {
    expect(decidirComIa([sim(), falhou], politica()).aprovado).toBe(false);
    expect(decidirComIa([sim(), falhou], politica({ falha: 'ignora' })).aprovado).toBe(true);
    expect(decidirComIa([falhou, falhou], politica({ falha: 'ignora' })).aprovado).toBe(true);
    expect(decidirComIa([falhou, falhou], politica()).aprovado).toBe(false);
  });

  it('obrigatória sem nenhum conector: não sai (falha fechada)', () => {
    const d = decidirComIa([], politica({ falha: 'ignora' }));
    expect(d.aprovado).toBe(false);
    expect(d.motivo).toMatch(/nenhum conector/);
  });

  it('consultiva nunca barra', () => {
    expect(decidirComIa([nao(), nao()], politica({ modo: 'consultivo' }))).toMatchObject({ aprovado: true });
  });
});

describe('saída do piloto automático', () => {
  const regras = { stopPct: 3, alvoPct: 6, protecaoPct: 2.5, recuoPct: 1.5 };

  it('stop: queda de 3% desde a compra fecha a posição', () => {
    expect(conferirSaida(100, 97.5, 100, regras)).toEqual({ sair: false });
    expect(conferirSaida(100, 97, 100, regras)).toMatchObject({ sair: true, tipo: 'stop' });
  });
  it('alvo: alta de 6% realiza o ganho', () => {
    expect(conferirSaida(100, 106, 106, regras)).toMatchObject({ sair: true, tipo: 'alvo' });
  });
  it('proteção: depois de +2,5%, recuo de 1,5% do topo fecha; antes de +2,5%, não', () => {
    expect(conferirSaida(100, 100.5, 102, regras)).toEqual({ sair: false }); // topo de +2%: proteção não ligou
    expect(conferirSaida(100, 102, 103, regras)).toEqual({ sair: false }); // recuo de 0,97%
    expect(conferirSaida(100, 101.4, 103, regras)).toMatchObject({ sair: true, tipo: 'protecao' }); // recuo de 1,55%
  });
  it('proteção nunca deixa sair no prejuízo: o gatilho tem piso no preço médio mais as taxas', () => {
    const r = { ...regras, recuoPct: 10 };
    expect(conferirSaida(100, 100.5, 103, r)).toEqual({ sair: false });
    expect(conferirSaida(100, 100 * PISO_PROTECAO, 103, r)).toMatchObject({ sair: true, tipo: 'protecao' });
  });
  it('o preço atual conta como topo, e dado ruim não manda sair', () => {
    expect(conferirSaida(100, 103, 0, regras)).toEqual({ sair: false });
    expect(conferirSaida(0, 50, 0, regras)).toEqual({ sair: false });
    expect(conferirSaida(100, Number.NaN, 0, regras)).toEqual({ sair: false });
  });
});

describe('stop sugerido para o dono registrar na corretora (assistente)', () => {
  const regras = { stopPct: 3, alvoPct: 6, protecaoPct: 2.5, recuoPct: 1.5 };
  it('antes da proteção, o stop de perda; depois, sobe com o topo e nunca fica no prejuízo', () => {
    expect(stopSugerido(100, 101, regras)).toBeCloseTo(97);
    expect(stopSugerido(100, 104, regras)).toBeCloseTo(104 * 0.985);
    expect(stopSugerido(100, 102.5, { ...regras, recuoPct: 10 })).toBeCloseTo(100 * PISO_PROTECAO);
  });
  it('é o mesmo nível em que a saída dispara', () => {
    const s = stopSugerido(100, 104, regras);
    expect(conferirSaida(100, s + 0.01, 104, regras)).toEqual({ sair: false });
    expect(conferirSaida(100, s, 104, regras)).toMatchObject({ sair: true, tipo: 'protecao' });
  });
  it('só avisa quando o stop sobe 0,5% ou mais sobre o último aviso', () => {
    expect(deveAvisarStop(97.2, 97)).toBe(false);
    expect(deveAvisarStop(98, 97)).toBe(true);
    expect(deveAvisarStop(98, null)).toBe(false);
  });
});
