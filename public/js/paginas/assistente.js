import { api, botao, cabecalho, campo, data, fmt, h, icone, janela, lerForm, secao, selo, tentar, vazio } from '../base.js';

// Assistente XP: ações da B3 sem API de corretora. O bot manda o aviso (aqui e no Telegram) e o
// dono executa na corretora; a ordem só entra no histórico quando ele confirma o que fez.

const reais = (v) => `R$ ${fmt(v)}`;
const codigo = (s) => String(s).split('/')[0];
const SITUACAO = { pendente: ['esperando você', 'alerta'], confirmado: ['confirmado', 'ok'], recusado: ['não executado', 'neutro'], expirado: ['expirou', 'neutro'] };

function cartaoTelegram(t, recarregar) {
  if (!t.configurado) {
    const form = h('form', {
      class: 'form',
      onsubmit: async (ev) => {
        ev.preventDefault();
        if (await tentar(() => api('PUT', '/telegram', { token: lerForm(form).token }), 'Telegram configurado')) recarregar();
      },
    },
    h('ol', { class: 'passos' },
      h('li', {}, 'No Telegram, abra o ', h('strong', {}, '@BotFather'), ' e mande ', h('code', {}, '/newbot'), '.'),
      h('li', {}, 'Dê um nome (ex.: Meu Bot Financeiro) e um usuário terminado em "bot".'),
      h('li', {}, 'Ele responde com um token (123456:ABC…). Cole abaixo: ele fica cifrado e não volta para a tela.')),
    h('div', { class: 'campos' }, campo('Token do bot', { name: 'token', type: 'password', autocomplete: 'new-password', required: true, placeholder: '123456789:AA…' })),
    h('div', { class: 'acoes acoes-fim' }, botao('Ligar o Telegram', { nomeIcone: 'ok', type: 'submit' })));
    return secao('Avisos no Telegram', form);
  }
  if (!t.pareado) {
    const link = `https://t.me/${t.bot}?start=${t.codigo}`;
    return secao('Avisos no Telegram',
      h('p', {}, `Falta só ligar o seu chat ao bot @${t.bot}. No celular, abra o link abaixo e toque em "Começar" (ou mande `, h('code', {}, `/start ${t.codigo}`), ' para o bot).'),
      h('div', { class: 'acoes' },
        h('a', { class: 'botao', href: link, target: '_blank', rel: 'noopener' }, icone('enviar'), h('span', {}, `Abrir @${t.bot}`)),
        botao('Já mandei', { classe: 'secundario', nomeIcone: 'atualizar', onclick: () => recarregar() })));
  }
  return secao('Avisos no Telegram',
    h('div', { class: 'fichas' }, selo(`@${t.bot} ligado`, 'ok', 'ok')),
    h('p', { class: 'suave' }, 'Os avisos de compra, venda e "suba o stop" chegam no seu Telegram, com botões para responder.'),
    h('div', { class: 'acoes' },
      botao('Mandar um teste', { classe: 'pequeno secundario', nomeIcone: 'enviar', onclick: () => tentar(() => api('POST', '/telegram/testar'), 'Teste enviado: veja o Telegram') }),
      botao('Desligar', { classe: 'pequeno secundario', nomeIcone: 'fechar', onclick: async () => (await tentar(() => api('DELETE', '/telegram'), 'Telegram desligado')) && recarregar() })));
}

function outroPreco(a, recarregar) {
  const form = h('form', {
    class: 'form',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const d = lerForm(form);
      if (await tentar(() => api('POST', `/alertas/${a.id}/confirmar`, { preco: d.preco, quantidade: d.quantidade }), 'Registrado')) {
        dlg.fechar();
        recarregar();
      }
    },
  },
  h('div', { class: 'campos' },
    campo('Preço médio que saiu na XP', { name: 'preco', type: 'number', step: '0.01', min: '0.01', required: true, value: Number(a.preco_ref).toFixed(2) }),
    campo('Quantidade', { name: 'quantidade', type: 'number', step: '1', min: '1', required: true, value: Number(a.quantidade) })),
  h('div', { class: 'acoes acoes-fim' }, botao('Registrar', { nomeIcone: 'ok', type: 'submit' })));
  const dlg = janela(`${a.lado === 'compra' ? 'Comprei' : 'Vendi'} ${codigo(a.simbolo)}`, { icone: 'editar' }, form);
}

function cartaoAlerta(a, recarregar) {
  const compra = a.lado === 'compra';
  const [texto, classe] = SITUACAO[a.situacao] ?? [a.situacao, 'neutro'];
  const responder = (acao, sucesso) => async () => (await tentar(() => api('POST', `/alertas/${a.id}/${acao}`, {}), sucesso)) && recarregar();
  return h('article', { class: `cartao cartao-alerta ${a.situacao === 'pendente' ? 'em-real' : ''}` },
    h('div', { class: 'cartao-estrategia-topo' },
      h('div', {},
        h('span', { class: 'par' }, `${compra ? 'COMPRAR' : 'VENDER'} ${Number(a.quantidade)} ${codigo(a.simbolo)}`),
        h('h3', {}, `a ~${reais(a.preco_ref)}`),
        h('span', { class: 'suave' }, `${a.estrategia} · ${data(a.criado_em)}`)),
      selo(texto, classe)),
    compra && a.stop ? h('p', {}, 'Depois de comprar, registre na XP: ', h('strong', {}, `STOP de venda em ${reais(a.stop)}`), a.alvo ? ` e alvo em ${reais(a.alvo)}` : '', '.') : null,
    a.motivo ? h('p', { class: 'pequeno-texto suave' }, `Por quê: ${a.motivo}`) : null,
    a.situacao === 'confirmado' ? h('p', { class: 'pequeno-texto' }, `Executado: ${Number(a.quantidade_executada)} a ${reais(a.preco_executado)}`) : null,
    a.situacao === 'pendente'
      ? h('div', { class: 'cartao-acoes' },
          botao(`${compra ? 'Comprei' : 'Vendi'} a ${reais(a.preco_ref)}`, { classe: 'pequeno', nomeIcone: 'ok', onclick: responder('confirmar', 'Registrado') }),
          botao('Outro preço…', { classe: 'pequeno secundario', nomeIcone: 'editar', onclick: () => outroPreco(a, recarregar) }),
          botao(compra ? 'Não comprei' : 'Ainda tenho', { classe: 'pequeno secundario', nomeIcone: 'fechar', onclick: responder('recusar', 'Ok') }))
      : null);
}

export async function paginaAssistente({ recarregar }) {
  const [telegram, alertas] = await Promise.all([api('GET', '/telegram'), api('GET', '/alertas')]);
  const pendentes = alertas.filter((a) => a.situacao === 'pendente');
  const historico = alertas.filter((a) => a.situacao !== 'pendente');
  return [
    cabecalho('Assistente XP',
      'Ações da B3 na sua corretora, sem API: o bot analisa e manda o aviso; você executa na XP e confirma aqui ou no Telegram. O stop fica registrado na própria XP.',
      botao('Atualizar', { classe: 'secundario', nomeIcone: 'atualizar', onclick: () => recarregar() })),
    h('div', { class: 'destaque' }, icone('alerta'), h('p', {}, 'Para usar: em Contas, crie uma conta "b3 · Ações da B3 (assistido)". Em simulação o bot opera sozinho com saldo de mentira; em real (com as três chaves), cada compra e venda vira um aviso aqui.')),
    cartaoTelegram(telegram, recarregar),
    h('h2', {}, pendentes.length ? `Esperando você (${pendentes.length})` : 'Nenhum aviso esperando'),
    pendentes.length ? h('div', { class: 'grade-cartoes' }, pendentes.map((a) => cartaoAlerta(a, recarregar))) : null,
    h('h2', {}, 'Histórico'),
    historico.length
      ? h('div', { class: 'grade-cartoes' }, historico.map((a) => cartaoAlerta(a, recarregar)))
      : vazio('Sem avisos ainda', 'Os avisos aparecem quando o assistente aprova uma compra ou venda no pregão.', 'robo'),
  ];
}
