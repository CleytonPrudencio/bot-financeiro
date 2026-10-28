// Escritório virtual: cada robô analista cuida de um mercado na sua mesa; quando vê um sinal, leva
// a proposta até o chefe, que confere de novo; os dois decidem juntos e, se aprovado, o analista
// volta e executa. Tudo com dados FICTÍCIOS (mercado.js): nenhuma ordem sai daqui.
//
//   const escritorio = montarEscritorio(elemento); ...; escritorio.parar();

import { criarMercadoFicticio, formatarPreco, ifr, aleatorio } from './mercado.js';
import { analisar, decidirJuntos, executar, novaCarteira, verificarChefe } from './decisao.js';
import * as D from './desenho.js';

const PASSO_MERCADO = 0.25; // segundos (já com a velocidade) por passo do mercado
const CORREDOR_Y = 520;
const PONTO_REUNIAO = { x: 575, y: 342 };
const FILA = [
  { x: 712, y: 364 },
  { x: 770, y: 388 },
  { x: 828, y: 412 },
];

const VISUAL = {
  acoes: { cor: '#4f8ff7', corEscura: '#2c5fb8', simbolo: 'B3', mesa: { x: 250, y: 430 }, lado: 1 },
  btc: { cor: '#f7a23c', corEscura: '#c06d10', simbolo: '₿', mesa: { x: 1030, y: 430 }, lado: -1 },
  eth: { cor: '#9a7cf2', corEscura: '#6545c9', simbolo: 'Ξ', mesa: { x: 330, y: 640 }, lado: 1 },
  dolar: { cor: '#3cc48a', corEscura: '#1f8a5c', simbolo: '$', mesa: { x: 950, y: 640 }, lado: -1 },
};

const ANTENA = {
  trabalhando: '#3ddc84',
  dormindo: '#5a6b8a',
  indo: '#ffd166',
  fila: '#ffd166',
  reuniao: '#5ee7ff',
  voltando: '#9fb3c8',
};

// ------------------------------------------------------------------ DOM mínimo

function h(tag, attrs = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const f of filhos.flat()) if (f !== undefined && f !== null && f !== false) el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return el;
}

const pct = (x) => `${Math.round(x * 100)}%`;

// ------------------------------------------------------------------ montagem

export function montarEscritorio(raiz, opcoes = {}) {
  const reduzido = opcoes.reduzido ?? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const mercado = criarMercadoFicticio(opcoes.semente ?? Date.now());
  const predios = D.gerarPredios(aleatorio(7));

  let tempo = 0;
  let acumulado = 0;
  let velocidade = 1;
  let pausado = false;
  let ultimo = performance.now();
  let rafId = 0;
  let proximaConversa = 8;
  let selecionado = null;
  const particulas = [];
  const registro = [];

  // ---------------------------------------------------------------- robôs

  const robos = mercado.ativos.map((ativo, i) => {
    const v = VISUAL[ativo.id];
    const sDesk = D.escalaEm(v.mesa.y);
    const casa = { x: v.mesa.x + v.lado * 80 * sDesk, y: v.mesa.y - 3, lift: 86 * sDesk };
    return {
      id: ativo.id,
      nome: ativo.nome,
      ativo,
      carteira: novaCarteira(),
      mesa: v.mesa,
      casa,
      lado: v.lado,
      x: casa.x,
      y: casa.y,
      lift: casa.lift,
      vel: 0,
      caminho: [],
      aoChegar: null,
      tarefas: [],
      estado: 'trabalhando',
      espera: 10 + i * 6,
      cor: v.cor,
      corEscura: v.corEscura,
      simboloPeito: v.simbolo,
      antena: ANTENA.trabalhando,
      emocao: 'normal',
      olharX: -v.lado,
      olharY: 0.3,
      fase: i * 1.7,
      digitando: true,
    };
  });

  const chefe = {
    nome: 'Chefe',
    chefe: true,
    x: 718,
    y: 288,
    lift: 62,
    cor: '#4a5266',
    corEscura: '#2b3040',
    simboloPeito: '★',
    antena: '#e8c35a',
    olhoCor: '#ffe9a6',
    emocao: 'normal',
    olharX: -0.4,
    olharY: 0.4,
    fase: 0.4,
    fila: [],
    reuniao: null,
    tarefas: [],
  };

  function falar(quem, texto, duracao = 2.6, extra = {}) {
    quem.fala = { texto, desde: tempo, ate: tempo + duracao, ...extra };
  }
  function agendar(quem, emSegundos, fn) {
    quem.tarefas.push({ em: tempo + emSegundos, fn });
  }
  function rodarTarefas(quem) {
    const agora = quem.tarefas.filter((t) => t.em <= tempo);
    if (!agora.length) return;
    quem.tarefas = quem.tarefas.filter((t) => t.em > tempo);
    for (const t of agora) t.fn();
  }
  const posicoesAbertas = () => robos.filter((r) => r.carteira.quantidade > 0).length;

  // ---------------------------------------------------------------- caminhos

  function irPara(r, pontos, aoChegar) {
    r.caminho = pontos.map((p) => ({ lift: 0, ...p }));
    r.aoChegar = aoChegar;
    r.andando = true;
    r.digitando = false;
  }

  function caminhoAteCorredor(r) {
    const lateral = r.casa.x + r.lado * 125;
    return [
      { x: lateral, y: r.casa.y },
      { x: lateral, y: CORREDOR_Y },
      { x: 640, y: CORREDOR_Y },
      { x: 640, y: 420 },
    ];
  }

  function caminhoDeVolta(r) {
    const lateral = r.casa.x + r.lado * 125;
    const pontos = [];
    if (r.y < 400) pontos.push({ x: 640, y: 420 });
    pontos.push({ x: 640, y: CORREDOR_Y }, { x: lateral, y: CORREDOR_Y }, { x: lateral, y: r.casa.y }, { ...r.casa });
    return pontos;
  }

  function mover(r, dt) {
    if (!r.caminho.length) return;
    const alvo = r.caminho[0];
    const dx = alvo.x - r.x;
    const dy = alvo.y - r.y;
    const dist = Math.hypot(dx, dy);
    const restante = r.caminho.reduce((s, p, i, arr) => s + (i ? Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) : dist), 0);
    const maxima = (r.proposta?.urgente ? 230 : 150) * D.escalaEm(r.y);
    const desejada = Math.min(maxima, 40 + restante * 2.2); // freia perto do fim
    r.vel += (desejada - r.vel) * Math.min(1, dt * 5);
    const passo = r.vel * dt;
    if (dist <= passo || dist < 0.5) {
      r.x = alvo.x;
      r.y = alvo.y;
      r.lift = alvo.lift;
      r.caminho.shift();
      if (!r.caminho.length) {
        r.andando = false;
        r.vel = 0;
        r.inclinacao = 0;
        const fn = r.aoChegar;
        r.aoChegar = null;
        fn?.();
      }
      return;
    }
    r.x += (dx / dist) * passo;
    r.y += (dy / dist) * passo;
    r.lift += (alvo.lift - r.lift) * Math.min(1, passo / dist);
    r.inclinacao = reduzido ? 0 : Math.max(-0.18, Math.min(0.18, (dx / dist) * r.vel * 0.0011));
    r.olharX = Math.max(-1, Math.min(1, dx / dist));
    r.olharY = dy < 0 ? -0.6 : 0.4;
    r.deCostas = dy < -Math.abs(dx) * 0.8; // subindo o corredor: de costas para a câmera
  }

  // ---------------------------------------------------------------- fluxo da proposta

  function iniciarProposta(r, proposta) {
    r.proposta = proposta;
    r.estado = 'indo';
    r.emocao = 'surpreso';
    r.antena = ANTENA.indo;
    r.digitando = false;
    const lado = proposta.lado === 'compra' ? 'COMPRA' : 'VENDA';
    r.flash = { texto: `SINAL: ${lado}`, cor: 'rgba(255, 209, 102, ALFA)', ate: tempo + 1.4, duracao: 1.4 };
    falar(r, proposta.urgente ? `${proposta.motivo}! Preciso falar com o chefe.` : `Opa, sinal de ${lado.toLowerCase()} em ${r.ativo.simbolo}.`, 1.8);
    agendar(r, 1.1, () => {
      r.emocao = 'normal';
      r.segurandoTablet = true;
      irPara(r, caminhoAteCorredor(r), () => entrarNaFila(r));
    });
  }

  function entrarNaFila(r) {
    if (r.proposta.urgente) chefe.fila.unshift(r);
    else chefe.fila.push(r);
    r.estado = 'fila';
    r.antena = ANTENA.fila;
    reorganizarFila();
  }

  function reorganizarFila() {
    if (!chefe.reuniao && chefe.fila.length) {
      const proximo = chefe.fila.shift();
      proximo.estado = 'indo';
      irPara(proximo, [{ x: 640, y: 380 }, PONTO_REUNIAO], () => comecarReuniao(proximo));
    }
    chefe.fila.forEach((r, i) => {
      const lugar = FILA[Math.min(i, FILA.length - 1)];
      if (Math.hypot(r.x - lugar.x, r.y - lugar.y) > 2 || r.caminho.length) {
        irPara(r, [lugar], () => {
          r.olharX = -0.8;
          r.olharY = -0.5;
          r.emocao = 'pensando';
        });
      }
    });
  }

  function comecarReuniao(r) {
    r.estado = 'reuniao';
    r.antena = ANTENA.reuniao;
    r.deCostas = true;
    r.gesticulando = true;
    r.emocao = 'normal';
    const p = r.proposta;
    const verificacao = verificarChefe(p, r.ativo, r.carteira, posicoesAbertas());
    const decisao = decidirJuntos(p, verificacao);
    // linha do tempo da reunião (segundos desde o começo): o analista fala, o holograma abre, os
    // itens do chefe aparecem um a um, as notas, o carimbo e o holograma fecha antes das respostas
    const itens = 2.9;
    const passo = 0.55;
    const notas = itens + verificacao.itens.length * passo + 0.3;
    const carimbo = notas + 0.7;
    const tempos = { abrir: 2.2, itens, passo, notas, carimbo, fechar: carimbo + 1.5 };
    const reuniao = { robo: r, proposta: p, verificacao, decisao, desde: tempo, tempos };
    chefe.reuniao = reuniao;
    chefe.emocao = 'pensando';
    chefe.olharX = -0.9;

    const lado = p.lado === 'compra' ? 'COMPRA' : 'VENDA';
    falar(
      r,
      `Proposta: ${lado} ${r.ativo.simbolo} a ${formatarPreco(r.ativo, p.preco)}.\n${p.motivo}. Confiança ${pct(p.confianca)}.`,
      2.1,
      { deslocX: -110 },
    );

    const tNotas = tempos.notas;
    const tCarimbo = tempos.carimbo;
    agendar(chefe, tNotas, () => {
      falar(chefe, `Minha nota: ${pct(verificacao.nota)}. Juntos: ${pct(decisao.combinada)}.`, 1.8, { deslocX: 120 });
    });
    agendar(chefe, tCarimbo, () => {
      chefe.emocao = decisao.aprovado ? 'feliz' : 'triste';
      r.emocao = decisao.aprovado ? 'feliz' : 'triste';
      r.gesticulando = false;
      r.antena = decisao.aprovado ? '#3ddc84' : '#ff6b6b';
      if (decisao.aprovado) {
        soltarParticulas(640, 200, 'faisca', 22, '#3ddc84');
      }
    });
    agendar(chefe, tCarimbo + 0.9, () => {
      falar(chefe, decisao.aprovado ? 'Aprovado. Pode executar.' : `Não agora: ${decisao.motivo}.`, 1.9, { deslocX: 120 });
    });
    agendar(chefe, tempos.fechar + 0.4, () => {
      falar(r, decisao.aprovado ? 'Deixa comigo!' : 'Entendido, fica pra próxima.', 1.5, { deslocX: -110 });
    });
    agendar(chefe, tCarimbo + 3.0, () => terminarReuniao(reuniao));
  }

  function terminarReuniao(reuniao) {
    const r = reuniao.robo;
    chefe.reuniao = null;
    chefe.emocao = 'normal';
    chefe.olharX = -0.4;
    r.deCostas = false;
    r.estado = 'voltando';
    r.antena = ANTENA.voltando;
    r.decisao = reuniao.decisao;
    r.verificacao = reuniao.verificacao;
    registrar(reuniao);
    irPara(r, caminhoDeVolta(r), () => chegarNaMesa(r));
    reorganizarFila();
  }

  function chegarNaMesa(r) {
    r.segurandoTablet = false;
    r.olharX = -r.lado;
    r.olharY = 0.3;
    const p = r.proposta;
    const d = r.decisao;
    if (d?.aprovado) {
      const preco = r.ativo.preco;
      const { resultado } = executar(r.carteira, p.lado, preco);
      r.carteira.aprovadas++;
      const lado = p.lado === 'compra' ? 'COMPRADO' : 'VENDIDO';
      r.flash = { texto: lado, cor: 'rgba(61, 220, 132, ALFA)', ate: tempo + 1.6, duracao: 1.6 };
      const monitorX = r.mesa.x - r.lado * 38 * D.escalaEm(r.mesa.y);
      if (p.lado === 'venda' && resultado > 0) soltarParticulas(monitorX, r.mesa.y - 120, 'moeda', 14);
      else soltarParticulas(monitorX, r.mesa.y - 120, 'faisca', 16, p.lado === 'venda' ? '#ff9f68' : '#3ddc84');
      const texto =
        p.lado === 'compra'
          ? `Comprei a ${formatarPreco(r.ativo, preco)}.`
          : `Vendi a ${formatarPreco(r.ativo, preco)}: ${resultado >= 0 ? 'lucro' : 'prejuízo'} de ${r.ativo.moeda} ${Math.abs(resultado).toFixed(2)}.`;
      falar(r, texto, 2.4);
      atualizarRegistroExecucao(r, preco, resultado);
    } else {
      r.carteira.reprovadas++;
      r.emocao = 'normal';
    }
    r.estado = 'trabalhando';
    r.antena = ANTENA.trabalhando;
    r.digitando = true;
    r.proposta = null;
    r.decisao = null;
    r.espera = 24;
    agendar(r, 1.5, () => {
      if (r.estado === 'trabalhando') r.emocao = 'normal';
    });
  }

  function forcarSinal(r) {
    if (r.estado !== 'trabalhando') {
      falar(r, r.estado === 'dormindo' ? 'O mercado está fechado agora.' : 'Já estou ocupado!', 1.6);
      return;
    }
    const comPosicao = r.carteira.quantidade > 0;
    iniciarProposta(r, {
      ativoId: r.ativo.id,
      lado: comPosicao ? 'venda' : 'compra',
      preco: r.ativo.preco,
      motivo: 'sinal forçado (demonstração)',
      confianca: 0.72,
      indicadores: {},
    });
  }

  // ---------------------------------------------------------------- passo do mercado

  function passoMercado() {
    mercado.avancar();
    for (const r of robos) {
      const aberto = mercado.aberto(r.ativo);
      if (r.estado === 'dormindo' && aberto) {
        r.estado = 'trabalhando';
        r.emocao = 'surpreso';
        r.antena = ANTENA.trabalhando;
        r.digitando = true;
        falar(r, `Bom dia! ${r.ativo.mercado} abriu.`, 2);
        agendar(r, 1.2, () => (r.emocao = 'normal'));
      } else if (r.estado === 'trabalhando' && !aberto) {
        r.estado = 'dormindo';
        r.emocao = 'dormindo';
        r.antena = ANTENA.dormindo;
        r.digitando = false;
        falar(r, `${r.ativo.mercado} fechou. Até amanhã.`, 2);
      }
      if (r.estado !== 'trabalhando') continue;
      if (r.espera > 0) {
        r.espera--;
        continue;
      }
      const proposta = analisar(r.ativo, r.carteira);
      if (proposta) iniciarProposta(r, proposta);
    }
  }

  function conversaToa() {
    const livres = robos.filter((r) => r.estado === 'trabalhando' && (!r.fala || r.fala.ate < tempo));
    if (!livres.length) return;
    const r = livres[Math.floor(mercado.rand() * livres.length)];
    const indice = ifr(r.ativo.historico);
    const v = r.ativo.variacaoDia * 100;
    const frases = [
      `${r.ativo.simbolo} ${v >= 0 ? '+' : ''}${v.toFixed(2)}% hoje.`,
      indice > 65 ? `IFR em ${indice.toFixed(0)}: está esticado.` : indice < 35 ? `IFR em ${indice.toFixed(0)}: vendido demais.` : `IFR em ${indice.toFixed(0)}, nada de mais.`,
      r.carteira.quantidade > 0 ? `Posição aberta desde ${formatarPreco(r.ativo, r.carteira.precoEntrada)}.` : 'Sem posição. Esperando o cruzamento.',
      'Médias se aproximando. Olho vivo.',
    ];
    falar(r, frases[Math.floor(mercado.rand() * frases.length)], 2.4);
  }

  // ---------------------------------------------------------------- partículas

  function soltarParticulas(x, y, tipo, n, cor = '#ffffff') {
    if (reduzido) n = Math.ceil(n / 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 40 + Math.random() * 120;
      particulas.push({
        x, y, tipo, cor,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - (tipo === 'moeda' ? 140 : 60),
        giro: Math.random() * 6,
        raio: 2 + Math.random() * 3,
        vida: 1 + Math.random() * 0.6,
        vidaTotal: 1.6,
      });
    }
  }

  function atualizarParticulas(dt) {
    for (const p of particulas) {
      p.vida -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += (p.tipo === 'moeda' ? 420 : 160) * dt;
      p.giro += dt * 10;
    }
    for (let i = particulas.length - 1; i >= 0; i--) if (particulas[i].vida <= 0) particulas.splice(i, 1);
  }

  // ---------------------------------------------------------------- registro (painel lateral)

  function registrar(reuniao) {
    const r = reuniao.robo;
    const entrada = {
      hora: `dia ${mercado.relogio.dia} · ${mercado.horaTexto()}`,
      robo: r,
      proposta: reuniao.proposta,
      verificacao: reuniao.verificacao,
      decisao: reuniao.decisao,
      execucao: null,
    };
    registro.unshift(entrada);
    if (registro.length > 60) registro.pop();
    r.ultimaEntrada = entrada;
    desenharRegistro();
  }

  function atualizarRegistroExecucao(r, preco, resultado) {
    if (r.ultimaEntrada) r.ultimaEntrada.execucao = { preco, resultado };
    desenharRegistro();
  }

  // ---------------------------------------------------------------- DOM

  const canvas = h('canvas', { class: 'escritorio-canvas', role: 'img', 'aria-label': 'Escritório virtual com os robôs analistas e o robô chefe' });
  const palco = h('div', { class: 'escritorio-palco' }, canvas);
  const ctx = canvas.getContext('2d');
  const botaoPausa = h('button', { class: 'pequeno secundario', onclick: () => alternarPausa() }, 'Pausar');
  const botoesVel = [1, 2, 4].map((v) =>
    h('button', { class: `pequeno ${v === 1 ? '' : 'secundario'}`, onclick: () => definirVelocidade(v) }, `${v}x`),
  );
  const botaoTela = h('button', { class: 'pequeno secundario', onclick: () => telaCheia() }, 'Tela cheia');
  const listaRegistro = h('ol', { class: 'escritorio-registro', 'aria-live': 'polite' });
  const cartoes = robos.map((r) => {
    const el = h('div', { class: 'escritorio-cartao', onclick: () => selecionar(r) });
    el.style.borderLeftColor = r.cor;
    return { r, el };
  });
  const lateral = h(
    'aside',
    { class: 'escritorio-lado' },
    h('div', { class: 'acoes' }, botaoPausa, ...botoesVel, botaoTela),
    h('p', { class: 'rotulo' }, 'Dados fictícios: nenhuma ordem de verdade sai desta tela. Clique num robô para ver os detalhes.'),
    h('div', { class: 'escritorio-cartoes' }, cartoes.map((c) => c.el)),
    h('h2', {}, 'Decisões'),
    listaRegistro,
  );
  raiz.replaceChildren(h('div', { class: 'escritorio' }, palco, lateral));

  function alternarPausa() {
    pausado = !pausado;
    botaoPausa.textContent = pausado ? 'Continuar' : 'Pausar';
  }
  function definirVelocidade(v) {
    velocidade = v;
    botoesVel.forEach((b, i) => b.classList.toggle('secundario', [1, 2, 4][i] !== v));
  }
  function telaCheia() {
    if (document.fullscreenElement) document.exitFullscreen();
    else palco.requestFullscreen?.();
  }
  function selecionar(r) {
    selecionado = selecionado === r ? null : r;
    for (const x of robos) x.selecionado = x === selecionado;
    desenharCartoes();
  }

  function desenharCartoes() {
    for (const { r, el } of cartoes) {
      const c = r.carteira;
      const aberto = mercado.aberto(r.ativo);
      const mtm = c.quantidade > 0 ? (r.ativo.preco - c.precoEntrada) * c.quantidade : 0;
      const estado = {
        trabalhando: 'analisando',
        dormindo: 'mercado fechado',
        indo: 'indo ao chefe',
        fila: 'na fila do chefe',
        reuniao: 'em reunião',
        voltando: 'voltando',
      }[r.estado];
      const filhos = [
        h('div', { class: 'escritorio-cartao-topo' }, h('strong', {}, `${r.nome} · ${r.ativo.simbolo}`), h('span', { class: 'rotulo' }, estado)),
        h('div', { class: 'mono' }, formatarPreco(r.ativo, r.ativo.preco), ' ', h('span', { class: r.ativo.variacaoDia >= 0 ? 'ok' : 'perigo-txt' }, `${r.ativo.variacaoDia >= 0 ? '+' : ''}${(r.ativo.variacaoDia * 100).toFixed(2)}%`)),
        h(
          'div',
          { class: 'rotulo' },
          c.quantidade > 0 ? `posição desde ${formatarPreco(r.ativo, c.precoEntrada)} (${mtm >= 0 ? '+' : ''}${mtm.toFixed(2)})` : 'sem posição',
          ` · resultado ${c.resultado >= 0 ? '+' : ''}${c.resultado.toFixed(2)} · ${c.aprovadas} aprovadas, ${c.reprovadas} reprovadas`,
        ),
      ];
      if (r === selecionado) {
        const m = r.ativo.medias;
        const ult = (n) => m[n][m[n].length - 1];
        filhos.push(
          h(
            'div',
            { class: 'rotulo mono' },
            `média 9 ${ult(9).toFixed(r.ativo.casas)} · média 26 ${ult(26).toFixed(r.ativo.casas)} · média 60 ${ult(60).toFixed(r.ativo.casas)} · IFR ${ifr(r.ativo.historico).toFixed(0)}`,
          ),
          h('div', { class: 'acoes' }, h('button', { class: 'pequeno', disabled: !aberto || r.estado !== 'trabalhando', onclick: (ev) => { ev.stopPropagation(); forcarSinal(r); } }, 'Forçar sinal')),
        );
      }
      el.classList.toggle('selecionado', r === selecionado);
      el.replaceChildren(...filhos);
    }
  }

  function desenharRegistro() {
    listaRegistro.replaceChildren(
      ...registro.map((e) => {
        const p = e.proposta;
        const lado = p.lado === 'compra' ? 'compra' : 'venda';
        return h(
          'li',
          { class: e.decisao.aprovado ? 'aprovado' : 'reprovado' },
          h('div', { class: 'escritorio-cartao-topo' },
            h('strong', {}, `${e.robo.nome}: ${lado} ${e.robo.ativo.simbolo}`),
            h('span', { class: `selo ${e.decisao.aprovado ? 'ok' : 'perigo-txt'}` }, e.decisao.aprovado ? 'aprovado' : 'reprovado'),
          ),
          h('div', { class: 'rotulo' }, `${e.hora} · ${formatarPreco(e.robo.ativo, p.preco)} · ${p.motivo}`),
          h('div', { class: 'rotulo' }, `analista ${pct(p.confianca)} · chefe ${pct(e.verificacao.nota)} · juntos ${pct(e.decisao.combinada)} · ${e.decisao.motivo}`),
          h('ul', { class: 'escritorio-itens' }, e.verificacao.itens.map((i) => h('li', { class: i.ok ? 'ok' : 'perigo-txt' }, `${i.ok ? '✔' : '✖'} ${i.texto}`))),
          e.execucao
            ? h('div', { class: 'rotulo' }, `executado a ${formatarPreco(e.robo.ativo, e.execucao.preco)}${p.lado === 'venda' ? ` · resultado ${e.execucao.resultado >= 0 ? '+' : ''}${e.execucao.resultado.toFixed(2)}` : ''}`)
            : null,
        );
      }),
    );
  }

  // clique no canvas: seleciona o robô mais perto
  canvas.addEventListener('click', (ev) => {
    const ret = canvas.getBoundingClientRect();
    const x = ((ev.clientX - ret.left) / ret.width) * D.LARGURA;
    const y = ((ev.clientY - ret.top) / ret.height) * D.ALTURA;
    let melhor = null;
    let menor = 60;
    for (const r of robos) {
      const d = Math.hypot(r.x - x, r.y - r.lift - 60 * D.escalaEm(r.y) * D.TAMANHO_ROBO - y);
      if (d < menor) {
        menor = d;
        melhor = r;
      }
    }
    if (melhor) selecionar(melhor);
  });

  // ---------------------------------------------------------------- tamanho e cenário fixo

  let fundo = null;
  function redimensionar() {
    const largura = palco.clientWidth || 800;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(largura * dpr);
    canvas.height = Math.round((largura * dpr * D.ALTURA) / D.LARGURA);
    canvas.style.height = `${(largura * D.ALTURA) / D.LARGURA}px`;
    const k = canvas.width / D.LARGURA;
    fundo = document.createElement('canvas');
    fundo.width = canvas.width;
    fundo.height = canvas.height;
    const fctx = fundo.getContext('2d');
    fctx.setTransform(k, 0, 0, k, 0, 0);
    D.desenharCenarioFixo(fctx, aleatorio(42));
  }
  const observador = new ResizeObserver(() => redimensionar());
  observador.observe(palco);
  redimensionar();

  // ---------------------------------------------------------------- laço

  function atualizar(dt) {
    tempo += dt;
    acumulado += dt;
    while (acumulado >= PASSO_MERCADO) {
      acumulado -= PASSO_MERCADO;
      passoMercado();
    }
    if (tempo >= proximaConversa) {
      conversaToa();
      proximaConversa = tempo + 14 + mercado.rand() * 16;
    }
    for (const r of robos) {
      rodarTarefas(r);
      mover(r, dt);
    }
    rodarTarefas(chefe);
    atualizarParticulas(dt);
  }

  function desenhar() {
    const k = canvas.width / D.LARGURA;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, D.LARGURA, D.ALTURA);
    const luz = mercado.luzDoDia();
    D.desenharCeu(ctx, luz, tempo, predios);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(fundo, 0, 0);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    D.desenharQuadroCotacoes(ctx, mercado.ativos, tempo, mercado.horaTexto(), mercado.relogio.dia);

    // sala do chefe: chefe sentado, mesa e vidro
    desenharRoboNaPosicao(chefe);
    D.desenharMesaChefe(ctx, tempo);
    D.desenharVidroSala(ctx);

    // o resto em ordem de profundidade
    const itens = [];
    for (const r of robos) {
      itens.push({ y: r.mesa.y, desenhar: () => D.desenharMesa(ctx, r.mesa, r.ativo, r, tempo, mercado.aberto(r.ativo)) });
      itens.push({ y: r.y, desenhar: () => desenharRoboNaPosicao(r) });
    }
    itens.sort((a, b) => a.y - b.y);
    for (const it of itens) it.desenhar();

    D.desenharLuz(ctx, luz, tempo);
    const reuniao = chefe.reuniao;
    if (reuniao) D.desenharHolograma(ctx, reuniao, tempo, reuniao.robo.ativo);
    D.desenharParticulas(ctx, particulas);
    for (const r of [...robos, chefe]) D.desenharBalao(ctx, comoDesenho(r), tempo);

    // selo de simulação
    ctx.fillStyle = 'rgba(178, 107, 0, 0.92)';
    ctx.beginPath();
    ctx.roundRect(14, 12, 238, 24, 6);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SIMULAÇÃO · DADOS FICTÍCIOS', 26, 28);
    if (pausado) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, D.LARGURA, D.ALTURA);
      ctx.fillStyle = '#fff';
      ctx.font = '700 28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('PAUSADO', D.LARGURA / 2, D.ALTURA / 2);
    }
  }

  /** O desenho usa a posição "levantada" (sentado atrás da mesa) e a escala da profundidade real. */
  function comoDesenho(r) {
    return { ...r, y: r.y - (r.lift ?? 0), escalaY: r.y, levantado: (r.lift ?? 0) > 6 };
  }
  function desenharRoboNaPosicao(r) {
    D.desenharRobo(ctx, comoDesenho(r), tempo, reduzido);
  }

  let proximaAtualizacaoDom = 0;
  function quadro(agora) {
    const dtReal = Math.min(0.05, (agora - ultimo) / 1000);
    ultimo = agora;
    if (!pausado) atualizar(dtReal * velocidade);
    desenhar();
    if (agora >= proximaAtualizacaoDom) {
      desenharCartoes();
      proximaAtualizacaoDom = agora + 500;
    }
    rafId = requestAnimationFrame(quadro);
  }
  rafId = requestAnimationFrame(quadro);

  return {
    parar() {
      cancelAnimationFrame(rafId);
      observador.disconnect();
    },
    // para testes e demonstração
    _estado: { robos, chefe, mercado, registro, forcarSinal, definirVelocidade },
  };
}
