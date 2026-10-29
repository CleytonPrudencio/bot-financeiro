import { describe, expect, it } from 'vitest';
import { lerParecer } from '../src/ia/prompt.js';
import { limparErro } from '../src/ia/compativel.js';

describe('leitura do parecer', () => {
  it('JSON puro, com cerca de código e com pensamento antes', () => {
    expect(lerParecer('{"decisao":"aprovar","confianca":0.7,"motivo":"ok"}')).toEqual({ decisao: 'aprovar', confianca: 0.7, motivo: 'ok' });
    expect(lerParecer('```json\n{"decisao":"vetar","confianca":"0.9","motivo":"x"}\n```').decisao).toBe('vetar');
    expect(lerParecer('<think>se {a} então</think>{"decisao":"vetar","confianca":0.5,"motivo":"y"}').motivo).toBe('y');
  });

  it('confiança em porcentagem vira fração; fora da faixa é cortada', () => {
    expect(lerParecer('{"decisao":"aprovar","confianca":80,"motivo":"ok"}').confianca).toBe(0.8);
    expect(lerParecer('{"decisao":"aprovar","confianca":-3,"motivo":"ok"}').confianca).toBe(0);
  });

  it('formato errado é erro (vira falha da IA, não aprovação)', () => {
    expect(() => lerParecer('aprovo')).toThrow();
    expect(() => lerParecer('{"decisao":"comprar","confianca":1,"motivo":"x"}')).toThrow();
  });
});

describe('erros dos provedores', () => {
  it('nunca mostram a chave', () => {
    expect(limparErro('Incorrect API key provided: sk-abc123456789xyz', null)).not.toContain('abc123456789');
    expect(limparErro('chave minha-chave-secreta recusada', 'minha-chave-secreta')).toBe('chave *** recusada');
  });
});
