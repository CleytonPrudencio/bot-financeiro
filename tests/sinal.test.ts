import { describe, expect, it } from 'vitest';
import { lerSinal, mesmoSimbolo } from '../src/sinal.js';
import { simularCompra, simularVenda } from '../src/brokers/simulacao.js';
import { cifrar, decifrar, derivarChave, hashToken, iguaisSeguro, novoToken } from '../src/crypto.js';

describe('lerSinal', () => {
  it('aceita o texto que o TradingView manda', () => {
    const r = lerSinal('{"acao":"buy","simbolo":"BINANCE:BTCUSDT","preco":"50123.5","id":1730000000}');
    expect(r).toEqual({ ok: true, sinal: { acao: 'comprar', simbolo: 'BTCUSDT', preco: 50123.5, id: '1730000000', valor: undefined, quantidade: undefined } });
  });

  it('sinônimos das ações', () => {
    for (const [entrada, saida] of [['COMPRA', 'comprar'], ['sell', 'vender'], ['close', 'zerar'], ['fechar', 'zerar']]) {
      expect(lerSinal({ acao: entrada })).toMatchObject({ ok: true, sinal: { acao: saida } });
    }
  });

  it('recusa JSON quebrado, ação desconhecida e número negativo', () => {
    expect(lerSinal('{acao: comprar')).toMatchObject({ ok: false });
    expect(lerSinal({ acao: 'segurar' })).toMatchObject({ ok: false });
    expect(lerSinal({ acao: 'comprar', valor: -5 })).toMatchObject({ ok: false });
    expect(lerSinal({})).toMatchObject({ ok: false });
  });
});

describe('mesmoSimbolo', () => {
  it('ignora barra, caixa e prefixo da exchange', () => {
    expect(mesmoSimbolo('btc/brl', 'BTC/BRL')).toBe(true);
    expect(mesmoSimbolo('MERCADO:BTCBRL', 'BTC/BRL')).toBe(true);
    expect(mesmoSimbolo('ETHBRL', 'BTC/BRL')).toBe(false);
  });
});

describe('simulação', () => {
  it('compra desconta a taxa da quantidade', () => {
    const e = simularCompra(100, 50_000, 0.1);
    expect(e.custo).toBe(100);
    expect(e.taxa).toBeCloseTo(0.1);
    expect(e.quantidade).toBeCloseTo(99.9 / 50_000, 12);
  });
  it('venda devolve o bruto e calcula a taxa', () => {
    const e = simularVenda(0.002, 60_000, 0.1);
    expect(e.custo).toBeCloseTo(120);
    expect(e.taxa).toBeCloseTo(0.12);
  });
  it('sem preço não simula', () => {
    expect(() => simularCompra(100, 0, 0.1)).toThrow();
  });
});

describe('cifra das chaves', () => {
  const chave = derivarChave('uma frase longa de teste');
  it('ida e volta', () => {
    const c = cifrar('minha-api-secret', chave);
    expect(c.startsWith('v1:')).toBe(true);
    expect(c).not.toContain('minha-api-secret');
    expect(decifrar(c, chave)).toBe('minha-api-secret');
  });
  it('chave errada ou texto adulterado falham', () => {
    const c = cifrar('segredo', chave);
    expect(() => decifrar(c, derivarChave('outra'))).toThrow();
    const bytes = Buffer.from(c.slice(3), 'base64');
    bytes[bytes.length - 1]! ^= 0x01; // troca um bit do texto cifrado
    expect(() => decifrar('v1:' + bytes.toString('base64'), chave)).toThrow();
  });
  it('token do webhook: só o hash, comparação segura', () => {
    const t = novoToken();
    expect(t.token.length).toBeGreaterThanOrEqual(40);
    expect(hashToken(t.token)).toBe(t.hash);
    expect(iguaisSeguro(t.hash, hashToken(t.token))).toBe(true);
    expect(iguaisSeguro(t.hash, hashToken('outro'))).toBe(false);
  });
});
