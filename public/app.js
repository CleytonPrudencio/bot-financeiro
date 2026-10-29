// Painel do Bot Financeiro: moldura (menu lateral, topo, faixa de cotações), rotas e transições.
// As páginas ficam em js/paginas/; a base (DOM seguro, API, avisos) em js/base.js.

import { $, api, botaoIcone, h, icone, marca, precoCompacto, quandoSessaoExpirar, reduzido, tentar } from './js/base.js';
import { telaLogin } from './js/login.js';
import { paginaPainel } from './js/paginas/painel.js';
import { paginaEstrategias } from './js/paginas/estrategias.js';
import { paginaContas } from './js/paginas/contas.js';
import { paginaIas } from './js/paginas/ias.js';
import { paginaAnalises } from './js/paginas/analises.js';
import { paginaAuditoria, paginaOrdens, paginaSinais } from './js/paginas/historico.js';

const conteudo = $('#conteudo');

async function paginaEscritorio() {
  const [{ montarEscritorio }, ias] = await Promise.all([import('./escritorio/escritorio.js'), api('GET', '/ias').catch(() => [])]);
  const caixa = h('div');
  const escritorio = montarEscritorio(caixa, {
    iasAtivas: ias.filter((c) => c.ativo).length,
    consultarIa: (pedido) => api('POST', '/ias/parecer', pedido),
  });
  limpar.push(() => escritorio.parar());
  return [
    h('div', { class: 'cabecalho' }, h('div', {}, h('h1', {}, 'Escritório'), h('p', { class: 'suave' }, 'Cada robô cuida de um mercado na própria mesa. Sinal bom vai para o chefe, que confere de novo antes de executar.'))),
    caixa,
  ];
}

const ROTAS = [
  { grupo: 'Visão geral' },
  { hash: '#/painel', nome: 'Painel', icone: 'painel', pagina: paginaPainel },
  { hash: '#/escritorio', nome: 'Escritório', icone: 'escritorio', pagina: paginaEscritorio, larga: true },
  { grupo: 'Operação' },
  { hash: '#/estrategias', nome: 'Estratégias', icone: 'estrategias', pagina: paginaEstrategias },
  { hash: '#/contas', nome: 'Contas', icone: 'contas', pagina: paginaContas },
  { hash: '#/ias', nome: 'IAs', icone: 'ias', pagina: paginaIas, novo: true },
  { hash: '#/analises', nome: 'Análises', icone: 'analise', pagina: paginaAnalises, novo: true },
  { grupo: 'Histórico' },
  { hash: '#/sinais', nome: 'Sinais', icone: 'sinais', pagina: paginaSinais },
  { hash: '#/ordens', nome: 'Ordens', icone: 'ordens', pagina: paginaOrdens },
  { hash: '#/auditoria', nome: 'Auditoria', icone: 'auditoria', pagina: paginaAuditoria },
];
const PAGINAS = ROTAS.filter((r) => r.hash);

// o que a página atual deixou rodando (laço do canvas, atualização automática)
let limpar = [];
function limparPagina() {
  for (const fn of limpar) fn();
  limpar = [];
}

// ------------------------------------------------------------------ moldura

let resumo = null;
let email = '';
let relogioId = 0;

function montarMoldura() {
  $('#marca').replaceChildren(marca(), h('span', { class: 'marca-texto' }, h('strong', {}, 'Bot Financeiro'), h('small', {}, 'Mesa de operações')));
  const indicador = h('span', { class: 'menu-indicador', 'aria-hidden': 'true' });
  $('#menu').replaceChildren(
    indicador,
    ...ROTAS.map((r) =>
      r.grupo
        ? h('span', { class: 'menu-grupo' }, r.grupo)
        : h('a', { href: r.hash, class: 'menu-item', 'data-hash': r.hash, onclick: () => fecharMenu() }, icone(r.icone), h('span', {}, r.nome), r.novo ? h('span', { class: 'menu-novo' }, 'novo') : null),
    ),
  );
  $('#lateral-pe').replaceChildren(
    h('div', { class: 'estado-robo', id: 'estado-robo' }),
    h('div', { class: 'usuario' }, h('span', { class: 'avatar avatar-usuario' }, email.slice(0, 1).toUpperCase()), h('span', { class: 'usuario-email' }, email),
      botaoIcone('sair', 'Sair', { onclick: sair })),
  );
  const relogio = h('span', { class: 'relogio mono' });
  const tick = () => {
    relogio.textContent = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  };
  tick();
  clearInterval(relogioId);
  relogioId = setInterval(tick, 1000);
  $('#topo').replaceChildren(
    botaoIcone('menu', 'Menu', { class: 'so-celular', onclick: () => document.body.classList.toggle('menu-aberto') }),
    h('div', { class: 'faixa-cotacoes', id: 'cotacoes' }),
    h('div', { class: 'topo-direita' },
      h('span', { class: 'topo-relogio' }, icone('relogio'), relogio, h('small', { class: 'suave' }, 'Brasília')),
      h('span', { class: 'pilula', id: 'pilula-modo' }),
      botaoIcone(document.documentElement.dataset.tema === 'claro' ? 'lua' : 'sol', 'Trocar tema', { id: 'botao-tema', onclick: trocarTema }),
    ),
  );
  $('#fundo-menu').onclick = fecharMenu;
}

function fecharMenu() {
  document.body.classList.remove('menu-aberto');
}

function trocarTema() {
  const claro = document.documentElement.dataset.tema !== 'claro';
  document.documentElement.classList.add('trocando-tema');
  if (claro) document.documentElement.dataset.tema = 'claro';
  else delete document.documentElement.dataset.tema;
  try {
    localStorage.setItem('tema', claro ? 'claro' : 'escuro');
  } catch {
    // sem armazenamento: vale só nesta aba
  }
  $('#botao-tema').replaceChildren(icone(claro ? 'lua' : 'sol'));
  setTimeout(() => document.documentElement.classList.remove('trocando-tema'), 400);
}

function moverIndicador() {
  const ativo = $('.menu-item.ativo');
  const ind = $('.menu-indicador');
  if (!ativo || !ind) return;
  ind.style.setProperty('transform', `translateY(${ativo.offsetTop}px)`);
  ind.style.setProperty('height', `${ativo.offsetHeight}px`);
  ind.classList.add('visivel');
}

async function atualizarEstado() {
  try {
    resumo = await api('GET', '/resumo');
  } catch {
    return;
  }
  const pilula = $('#pilula-modo');
  const faixa = $('#faixa');
  const estado = $('#estado-robo');
  if (resumo.parada_geral) {
    pilula.className = 'pilula pilula-perigo';
    pilula.replaceChildren(h('i', { class: 'pulso' }), 'PARADA GERAL');
    faixa.className = 'faixa faixa-perigo';
    faixa.replaceChildren(icone('alerta'), h('span', {}, 'Parada geral ligada: nenhuma ordem sai, de nenhuma estratégia.'), h('a', { href: '#/painel' }, 'Desligar no painel'));
    faixa.hidden = false;
    estado.replaceChildren(h('span', { class: 'ponto-vivo perigo' }), h('div', {}, h('strong', {}, 'Parado'), h('small', { class: 'suave' }, 'parada geral ligada')));
  } else {
    const emReal = resumo.estrategias.some((e) => e.real && e.conta_modo === 'real' && resumo.real_no_servidor);
    pilula.className = `pilula ${emReal ? 'pilula-real' : 'pilula-simulacao'}`;
    pilula.replaceChildren(h('i', { class: 'pulso' }), emReal ? 'DINHEIRO REAL' : 'SIMULAÇÃO');
    faixa.hidden = true;
    const ativas = resumo.estrategias.filter((e) => e.ativa).length;
    estado.replaceChildren(h('span', { class: 'ponto-vivo vivo' }), h('div', {}, h('strong', {}, 'Operando'), h('small', { class: 'suave' }, `${ativas} estratégia(s) ativa(s)`)));
  }
}

// faixa de cotações dos pares das estratégias, com piscada verde/vermelha quando muda
const ultimas = new Map();
async function atualizarCotacoes() {
  const el = $('#cotacoes');
  let dados;
  try {
    dados = await api('GET', '/cotacoes');
  } catch {
    return;
  }
  if (!dados.length) {
    el.replaceChildren(h('span', { class: 'suave cotacoes-vazio' }, icone('cotacao'), 'As cotações dos pares das suas estratégias aparecem aqui'));
    return;
  }
  const itens = () =>
    dados.map((d) => {
      const chave = `${d.exchange}:${d.simbolo}`;
      const antes = ultimas.get(chave);
      const dir = antes === undefined || d.cotacao === null || d.cotacao === antes ? '' : d.cotacao > antes ? 'sobe' : 'desce';
      return h('span', { class: `cotacao ${dir}` }, h('strong', {}, d.simbolo), h('span', { class: 'mono' }, precoCompacto(d.cotacao)), h('small', { class: 'suave' }, d.exchange), dir ? icone(dir === 'sobe' ? 'compra' : 'venda') : null);
    });
  const trilho = h('div', { class: 'cotacoes-trilho' }, itens(), dados.length > 2 ? itens() : null);
  if (dados.length > 2 && !reduzido()) trilho.classList.add('rolando');
  el.replaceChildren(trilho);
  for (const d of dados) if (d.cotacao !== null) ultimas.set(`${d.exchange}:${d.simbolo}`, d.cotacao);
}

// ------------------------------------------------------------------ rotas

let rotaAtual = null;
let geracao = 0;

function esqueleto() {
  return h('div', { class: 'esqueleto-pagina' },
    h('div', { class: 'esqueleto esqueleto-titulo' }),
    h('div', { class: 'grade-kpi' }, [1, 2, 3, 4].map(() => h('div', { class: 'esqueleto esqueleto-cartao' }))),
    h('div', { class: 'esqueleto esqueleto-bloco' }));
}

async function rota({ suave = false } = {}) {
  const r = PAGINAS.find((p) => p.hash === location.hash) ?? PAGINAS[0];
  const mesma = rotaAtual === r;
  rotaAtual = r;
  const minha = ++geracao;
  limparPagina();
  for (const a of document.querySelectorAll('.menu-item')) a.classList.toggle('ativo', a.dataset.hash === r.hash);
  moverIndicador();
  document.title = `${r.nome} · Bot Financeiro`;
  conteudo.classList.toggle('conteudo-largo', Boolean(r.larga));

  const rolagem = window.scrollY;
  let mostrouEsqueleto = false;
  const timer = suave ? 0 : setTimeout(() => {
    mostrouEsqueleto = true;
    conteudo.replaceChildren(esqueleto());
  }, 160);
  if (!suave && !mesma) conteudo.classList.add('saindo');

  const contexto = {
    recarregar: (o) => rota(o),
    agendar: (fn, ms) => {
      const id = setInterval(fn, ms);
      limpar.push(() => clearInterval(id));
    },
    aoSair: (fn) => limpar.push(fn),
  };
  let filhos;
  try {
    filhos = await r.pagina(contexto);
  } catch (e) {
    if (e.message === 'sessão expirou') return;
    filhos = [h('div', { class: 'cartao erro-pagina' }, icone('alerta'), h('div', {}, h('strong', {}, 'Não deu para carregar esta página'), h('p', { class: 'suave' }, e.message)))];
  }
  clearTimeout(timer);
  if (minha !== geracao) return; // o usuário já foi para outra página
  conteudo.classList.remove('saindo');
  conteudo.replaceChildren(...filhos.filter(Boolean));
  if (!suave) {
    conteudo.classList.remove('entrando');
    void conteudo.offsetWidth; // reinicia a animação de entrada
    conteudo.classList.add('entrando');
    if (!mesma || mostrouEsqueleto) window.scrollTo(0, 0);
  } else {
    conteudo.classList.add('sem-entrada');
    window.scrollTo(0, rolagem);
    requestAnimationFrame(() => conteudo.classList.remove('sem-entrada'));
  }
  atualizarEstado();
}

// ------------------------------------------------------------------ sessão

function mostrarLogin() {
  limparPagina();
  $('#app').hidden = true;
  document.body.classList.add('na-entrada');
  telaLogin($('#login'), iniciar);
}

async function sair() {
  await tentar(() => api('POST', '/logout'));
  mostrarLogin();
}

quandoSessaoExpirar(mostrarLogin);

let intervalos = [];
async function iniciar() {
  let s;
  try {
    s = await api('GET', '/sessao');
  } catch {
    return; // mostrarLogin já foi chamado pelo 401
  }
  email = s.email;
  $('#login').replaceChildren();
  document.body.classList.remove('na-entrada');
  $('#app').hidden = false;
  montarMoldura();
  window.onhashchange = () => rota();
  window.onresize = () => moverIndicador();
  for (const id of intervalos) clearInterval(id);
  intervalos = [setInterval(atualizarEstado, 30_000), setInterval(atualizarCotacoes, 30_000)];
  atualizarCotacoes();
  await rota();
}

iniciar();
