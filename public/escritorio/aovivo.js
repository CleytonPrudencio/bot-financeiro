// Escritório AO VIVO: a mesma animação, mas com o bot de verdade. Cada robô é uma estratégia; o
// preço é o da exchange; cada sinal que o bot recebeu (do piloto ou do webhook) vira uma reunião com
// o chefe, e o carimbo mostra o que o bot REALMENTE decidiu. Esta tela só lê: não manda ordem.
//
// `criarMercadoReal(dados)` devolve um objeto com a mesma forma do mercado fictício
// ({ ativos, relogio, avancar, aberto, horaTexto, luzDoDia, rand }) mais `atualizar(dados)`.

import { calcularMedias } from './mercado.js';

const FUSO = 'America/Sao_Paulo';

const CORES = {
  BTC: { cor: '#f7a23c', corEscura: '#c06d10', simbolo: '₿' },
  ETH: { cor: '#9a7cf2', corEscura: '#6545c9', simbolo: 'Ξ' },
  SOL: { cor: '#2fd3a8', corEscura: '#11906f', simbolo: 'S' },
  XRP: { cor: '#6f8cff', corEscura: '#3f56c9', simbolo: 'X' },
};
const PALETA = [
  { cor: '#4f8ff7', corEscura: '#2c5fb8' },
  { cor: '#3cc48a', corEscura: '#1f8a5c' },
  { cor: '#e05a5a', corEscura: '#a83434' },
  { cor: '#f2c94c', corEscura: '#b8901c' },
  { cor: '#a07a55', corEscura: '#6b4e33' },
];

/** Cor e símbolo do peito do robô, pela moeda base do par. */
export function visualDa(simbolo, indice = 0) {
  const base = simbolo.split('/')[0].toUpperCase();
  return CORES[base] ?? { ...PALETA[indice % PALETA.length], simbolo: base.slice(0, 3) };
}

function moedaDe(simbolo) {
  const cotacao = (simbolo.split('/')[1] ?? '').split(':')[0].toUpperCase();
  if (cotacao === 'BRL') return 'R$';
  if (['USDT', 'USDC', 'USD', 'FDUSD'].includes(cotacao)) return 'US$';
  return cotacao;
}

const casasPara = (preco) => (preco >= 1000 ? 0 : preco >= 1 ? 2 : 4);

function montarAtivo(e, indice) {
  const v = visualDa(e.simbolo, indice);
  const ativo = {
    id: `e${e.id}`,
    estrategiaId: e.id,
    categoria: 'real',
    nome: e.nome,
    simbolo: e.simbolo,
    mercado: e.exchange,
    horario: null,
    volDia: 0.03,
    sigma: 0.03,
    cor: v.cor,
    moeda: moedaDe(e.simbolo),
    historico: [],
    preco: 0,
    aberturaDia: 0,
    variacaoDia: 0,
    casas: 2,
    estrategia: e,
  };
  atualizarAtivo(ativo, e);
  return ativo;
}

function atualizarAtivo(a, e) {
  a.estrategia = e;
  a.nome = e.nome;
  const fechamentos = (e.fechamentos ?? []).filter((x) => Number.isFinite(x) && x > 0);
  // sem cotação agora: fica a última conhecida
  const preco = e.preco ?? (a.preco || fechamentos[fechamentos.length - 1]) ?? 0;
  a.semCotacao = !(preco > 0);
  a.preco = preco;
  a.casas = casasPara(preco);
  a.aberturaDia = e.abertura_hoje ?? fechamentos[fechamentos.length - 1] ?? preco;
  a.variacaoDia = a.aberturaDia ? preco / a.aberturaDia - 1 : 0;
  a.historico = preco ? [...fechamentos, preco] : fechamentos;
  if (a.historico.length < 2) a.historico = [preco || 1, preco || 1];
  calcularMedias(a);
}

export function criarMercadoReal(dados) {
  const ativos = dados.estrategias.map((e, i) => montarAtivo(e, i));
  const relogio = { minutos: 0, dia: 1 };
  let agora = () => Date.now();

  function avancar() {
    const partes = Object.fromEntries(
      new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', day: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(agora()))
        .map((p) => [p.type, p.value]),
    );
    relogio.minutos = Number(partes.hour) * 60 + Number(partes.minute);
    relogio.dia = Number(partes.day);
  }
  avancar();

  return {
    real: true,
    ativos,
    relogio,
    avancar,
    aberto: () => true, // cripto não fecha
    horaTexto: () => `${String(Math.floor(relogio.minutos / 60)).padStart(2, '0')}:${String(relogio.minutos % 60).padStart(2, '0')}`,
    luzDoDia: () => Math.max(0, Math.sin(((relogio.minutos / 60 - 6) / 12) * Math.PI)),
    rand: Math.random,
    /** Novos dados do servidor: preço, velas e o estado de cada estratégia. */
    atualizar(novos) {
      for (const e of novos.estrategias) {
        const a = ativos.find((x) => x.estrategiaId === e.id);
        if (a) atualizarAtivo(a, e);
      }
    },
    usarRelogio(fn) {
      agora = fn;
      avancar();
    },
  };
}

/** Posição real da estratégia no formato da "carteira" dos robôs. */
export function carteiraDa(e, carteira) {
  carteira.quantidade = Number(e.posicao) || 0;
  carteira.precoEntrada = carteira.quantidade > 0 ? Number(e.custo_posicao) / carteira.quantidade : 0;
  return carteira;
}

// ------------------------------------------------------------------ sinal real → reunião

const NOMES_ETAPA = { pesquisa: 'Pesquisa', sentimento: 'Sentimento', previsao: 'Kronos', tecnica: 'Técnica', risco: 'Risco' };
const curto = (t, n = 40) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function motivoDoSinal(s) {
  const id = s.id_externo ?? '';
  if (id.startsWith('piloto-entrada')) return 'virada para alta (piloto)';
  if (id.startsWith('piloto-stop')) return 'stop de perda (piloto)';
  if (id.startsWith('piloto-alvo')) return 'alvo de ganho (piloto)';
  if (id.startsWith('piloto-protecao')) return 'proteção do ganho (piloto)';
  if (id.startsWith('piloto-tendencia')) return 'tendência quebrou (piloto)';
  return s.ip === 'piloto' ? 'sinal do piloto' : 'sinal do webhook';
}

/**
 * Transforma um sinal do bot na proposta que o robô leva ao chefe. A decisão já vem pronta (é a que
 * o bot tomou): a reunião só encena o que aconteceu.
 */
export function propostaDoSinal(s, ativo) {
  const lado = s.acao === 'comprar' ? 'compra' : 'venda';
  const executado = s.situacao === 'executado';
  const origem = s.ip === 'piloto' ? 'Piloto automático' : 'Webhook';
  const itens = [{ texto: `Origem: ${origem}`, ok: true, peso: 1 }];
  const etapas = s.agente?.etapas ?? {};
  for (const [id, nome] of Object.entries(NOMES_ETAPA)) {
    const e = etapas[id];
    if (!e) continue;
    const r = e.resultado;
    if (e.ok === false || !r) itens.push({ texto: `${nome}: falhou`, ok: false, peso: 1 });
    else itens.push({ texto: `${nome}: ${r.vies.replace('_', ' ')} (${r.nota}/100)`, ok: r.vies !== 'contra', peso: 1 });
  }
  if (!s.agente) {
    for (const p of s.pareceres ?? []) {
      itens.push({ texto: curto(`IA ${p.conector}: ${p.decisao ?? 'falhou'}`), ok: p.decisao === 'aprovar', peso: 1 });
    }
  }
  itens.push({ texto: curto(executado ? 'Regras de risco: aprovado' : `Barrado: ${s.motivo ?? s.situacao}`), ok: executado, peso: 2 });
  const confianca = s.agente?.confianca ?? (executado ? 1 : 0);
  const modo = s.ordem?.modo === 'real' ? 'REAL' : 'simulada';
  return {
    real: true,
    sinalId: s.id,
    lado,
    preco: Number(s.ordem?.preco ?? ativo.preco),
    motivo: motivoDoSinal(s),
    confianca: Number(confianca),
    urgente: /^piloto-(stop|alvo|protecao)/.test(s.id_externo ?? ''),
    indicadores: {},
    ordem: s.ordem,
    quando: s.recebido_em,
    verificacao: { itens: itens.slice(-7), nota: Number(confianca) },
    decisao: {
      aprovado: executado,
      combinada: Number(confianca),
      motivo: executado ? `ordem ${modo} executada` : s.motivo ?? s.situacao,
    },
    rodape: `${origem} · ${executado ? `ordem ${modo}` : s.situacao}${s.agente ? ` · agente ${Math.round(Number(confianca) * 100)}%` : ''}`,
    falaChefe: executado
      ? `Aprovado. Ordem ${modo} executada a ${Number(s.ordem?.preco ?? 0).toLocaleString('pt-BR')}.`
      : `Não agora: ${curto(s.motivo ?? s.situacao, 70)}.`,
  };
}

export function horaDoSinal(s) {
  return new Date(s.recebido_em).toLocaleString('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
