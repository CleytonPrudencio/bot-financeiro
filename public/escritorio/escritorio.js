// Escritório virtual: cada robô analista cuida de um mercado na sua mesa; quando vê um sinal, leva
// a proposta até o chefe, que confere de novo; os dois decidem juntos e, se aprovado, o analista
// volta e executa. Dois modos:
//   - demonstração: dados FICTÍCIOS (mercado.js), os robôs decidem sozinhos; nenhuma ordem sai daqui;
//   - ao vivo (`opcoes.aoVivo`): cada robô é uma estratégia do bot, com preço real, e cada sinal que o
//     bot recebeu vira uma reunião que encena a decisão que o bot tomou de verdade (aovivo.js). Só lê.
//
//   const escritorio = montarEscritorio(elemento, { aoVivo: { dados, buscar, agora } }); ...; escritorio.parar();

import { CATEGORIAS, criarMercadoFicticio, formatarPreco, ifr, aleatorio } from './mercado.js';
import { analisar, aplicarConselho, decidirJuntos, executar, novaCarteira, verificarChefe, VALOR_POR_ORDEM } from './decisao.js';
import * as D from './desenho.js';
import { carteiraDa, criarMercadoReal, horaDoSinal, motivoDoRobo, propostaDoSinal, situacaoCurta, visualDa } from './aovivo.js';

const INTERVALO_AO_VIVO_MS = 15_000;

const PASSO_MERCADO = 0.25; // segundos (já com a velocidade) por passo do mercado
const CORREDOR_Y = 520;
const PONTO_REUNIAO = { x: 575, y: 342 };
const FILA = [
  { x: 712, y: 364 },
  { x: 770, y: 388 },
  { x: 828, y: 412 },
];

// cor do robô e símbolo no peito de cada mercado
const VISUAL = {
  btc: { cor: '#f7a23c', corEscura: '#c06d10', simbolo: '₿' },
  eth: { cor: '#9a7cf2', corEscura: '#6545c9', simbolo: 'Ξ' },
  sol: { cor: '#2fd3a8', corEscura: '#11906f', simbolo: 'S' },
  xrp: { cor: '#6f8cff', corEscura: '#3f56c9', simbolo: 'X' },
  acoes: { cor: '#3fb46c', corEscura: '#237a44', simbolo: 'P4' },
  vale: { cor: '#f0b43a', corEscura: '#b07a10', simbolo: 'V3' },
  ibov: { cor: '#4f8ff7', corEscura: '#2c5fb8', simbolo: 'B3' },
  dolar: { cor: '#3cc48a', corEscura: '#1f8a5c', simbolo: '$' },
  euro: { cor: '#4a7ee6', corEscura: '#2a4fa8', simbolo: '€' },
  ouro: { cor: '#f2c94c', corEscura: '#b8901c', simbolo: 'Au' },
  petroleo: { cor: '#a07a55', corEscura: '#6b4e33', simbolo: 'Br' },
  spx: { cor: '#e05a5a', corEscura: '#a83434', simbolo: 'US' },
};

/** Quem trabalha quando ninguém escolheu ainda: um de cada tipo de mercado. */
const ESCALA_PADRAO = ['btc', 'eth', 'sol', 'acoes', 'ibov', 'dolar', 'ouro', 'spx'];
const CHAVE_ESCALA = 'escritorio:escala';

function lerEscala() {
  try {
    const salva = JSON.parse(localStorage.getItem(CHAVE_ESCALA) ?? 'null');
    if (Array.isArray(salva)) return salva;
  } catch {
    // sem armazenamento: usa a padrão
  }
  return ESCALA_PADRAO;
}

function salvarEscala(ids) {
  try {
    localStorage.setItem(CHAVE_ESCALA, JSON.stringify(ids));
  } catch {
    // sem armazenamento: vale só nesta visita
  }
}

const ANTENA = {
  trabalhando: '#3ddc84',
  dormindo: '#5a6b8a',
  folga: '#b48cff',
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
  const aoVivo = opcoes.aoVivo ?? null;
  const mercado = aoVivo ? criarMercadoReal(aoVivo.dados) : criarMercadoFicticio(opcoes.semente ?? Date.now());
  // ao vivo, uma mesa para cada robô que trabalha (as fileiras crescem de 4 em 4)
  D.configurarMesas(aoVivo ? mercado.ativos.filter((a) => a.estrategia.ativa).length : 8);
  if (aoVivo?.agora) mercado.usarRelogio(aoVivo.agora);
  let ultimoSinal = 0;
  let buscaId = 0;
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
  // conselho de IAs: consulta as IAs de verdade (custa créditos), por isso começa desligado
  let conselhoLigado = false;
  const podeConselho = Boolean(opcoes.consultarIa) && (opcoes.iasAtivas ?? 0) > 0;

  // ---------------------------------------------------------------- robôs

  const escalaInicial = new Set(aoVivo ? mercado.ativos.filter((a) => a.estrategia.ativa).map((a) => a.id) : lerEscala());
  const vagaLivre = () => D.VAGAS_MESA.findIndex((_, i) => !robos.some((r) => r.vaga === i));
  /** Lugar livre na sala de descanso; prefere o lado da mesa de onde o robô sai. */
  function lugarLivre(ladoPreferido) {
    const livres = D.VAGAS_DESCANSO.map((v, i) => ({ v, i })).filter(({ i }) => !robos.some((r) => r.descanso === i));
    return (livres.find(({ v }) => v.lado === ladoPreferido) ?? livres[0])?.i ?? 0;
  }
  function casaDa(vaga) {
    const v = D.VAGAS_MESA[vaga];
    const s = D.escalaEm(v.y);
    return { x: v.x + v.lado * 80 * s, y: v.y - 3, lift: 86 * s };
  }

  const robos = [];
  mercado.ativos.forEach((ativo, i) => {
    const v = aoVivo ? visualDa(ativo.simbolo, i) : VISUAL[ativo.id];
    const r = {
      id: ativo.id,
      nome: aoVivo ? ativo.simbolo.split('/')[0] : ativo.nome,
      ativo,
      carteira: aoVivo && !ativo.olheiro ? carteiraDa(ativo.estrategia, novaCarteira()) : novaCarteira(),
      filaSinais: [],
      vaga: null,
      descanso: null,
      casa: null,
      lado: 1,
      x: 0,
      y: 0,
      lift: 0,
      vel: 0,
      caminho: [],
      aoChegar: null,
      tarefas: [],
      estado: 'folga',
      espera: 10 + (i % 8) * 6,
      cor: v.cor,
      corEscura: v.corEscura,
      simboloPeito: v.simbolo,
      antena: ANTENA.folga,
      emocao: 'dormindo',
      olharX: 0,
      olharY: 0.3,
      fase: i * 1.7,
      digitando: false,
    };
    robos.push(r);
    const vaga = escalaInicial.has(ativo.id) ? vagaLivre() : -1;
    if (vaga >= 0) {
      sentarNaMesa(r, vaga);
      r.estado = 'trabalhando';
      r.antena = ANTENA.trabalhando;
      r.emocao = 'normal';
      r.digitando = true;
    } else {
      r.descanso = lugarLivre(i % 2 ? 'dir' : 'esq');
      acomodarNoDescanso(r);
    }
  });

  function sentarNaMesa(r, vaga) {
    r.vaga = vaga;
    r.descanso = null;
    r.lado = D.VAGAS_MESA[vaga].lado;
    r.casa = casaDa(vaga);
    r.x = r.casa.x;
    r.y = r.casa.y;
    r.lift = r.casa.lift;
    r.olharX = -r.lado;
    r.caneca = false;
  }

  function acomodarNoDescanso(r) {
    const lugar = D.VAGAS_DESCANSO[r.descanso];
    r.x = lugar.x;
    r.y = lugar.y;
    r.lift = 0;
    r.caneca = Boolean(lugar.caneca);
    r.emocao = r.caneca ? 'feliz' : 'dormindo';
    r.antena = ANTENA.folga;
    r.olharX = lugar.lado === 'esq' ? 0.4 : -0.4;
    r.olharY = 0.4;
    r.digitando = false;
  }

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

  // cada mesa tem um corredor lateral (do lado de fora do robô) que liga a fileira ao corredor
  // de baixo (reunião) e à faixa de cima (descanso)
  const corredorDa = (r) => r.casa.x + r.lado * 42;

  function caminhoAteCorredor(r) {
    const lateral = corredorDa(r);
    return [
      { x: lateral, y: r.casa.y },
      { x: lateral, y: CORREDOR_Y },
      { x: 640, y: CORREDOR_Y },
      { x: 640, y: 420 },
    ];
  }

  function caminhoDeVolta(r) {
    const lateral = corredorDa(r);
    const pontos = [];
    if (r.y < 400) pontos.push({ x: 640, y: 420 });
    pontos.push({ x: 640, y: CORREDOR_Y }, { x: lateral, y: CORREDOR_Y }, { x: lateral, y: r.casa.y }, { ...r.casa });
    return pontos;
  }

  function caminhoAteDescanso(r) {
    const lugar = D.VAGAS_DESCANSO[r.descanso];
    const pontos = r.casa && !r.andando ? [{ x: corredorDa(r), y: r.casa.y }, { x: corredorDa(r), y: D.FAIXA_DESCANSO_Y }] : [{ x: r.x, y: D.FAIXA_DESCANSO_Y }];
    pontos.push({ x: lugar.x, y: D.FAIXA_DESCANSO_Y }, { x: lugar.x, y: lugar.y });
    return pontos;
  }

  function caminhoDoDescanso(r) {
    const lateral = corredorDa(r);
    return [{ x: r.x, y: D.FAIXA_DESCANSO_Y }, { x: lateral, y: D.FAIXA_DESCANSO_Y }, { x: lateral, y: r.casa.y }, { ...r.casa }];
  }

  // ---------------------------------------------------------------- escala do dia

  const naMesa = (r) => r.vaga !== null;
  const ocupado = (r) => ['indo', 'fila', 'reuniao', 'voltando'].includes(r.estado);

  /** Chama para trabalhar. Devolve false se não há mesa livre. */
  function escalar(r) {
    r.folgaPedida = false;
    if (naMesa(r)) return true;
    const vaga = vagaLivre();
    if (vaga < 0) return false;
    r.vaga = vaga;
    r.descanso = null;
    r.lado = D.VAGAS_MESA[vaga].lado;
    r.casa = casaDa(vaga);
    r.caneca = false;
    r.emocao = 'surpreso';
    r.estado = 'indo_mesa';
    r.antena = ANTENA.trabalhando;
    falar(r, ['Bora trabalhar!', 'Partiu mesa!', 'Voltei, chefe!'][Math.floor(mercado.rand() * 3)], 1.6);
    irPara(r, caminhoDoDescanso(r), () => chegarParaTrabalhar(r));
    return true;
  }

  function chegarParaTrabalhar(r) {
    const aberto = mercado.aberto(r.ativo);
    r.estado = aberto ? 'trabalhando' : 'dormindo';
    r.emocao = aberto ? 'normal' : 'dormindo';
    r.antena = aberto ? ANTENA.trabalhando : ANTENA.dormindo;
    r.digitando = aberto;
    r.olharX = -r.lado;
    r.olharY = 0.3;
    r.espera = 8;
    falar(r, aberto ? `Na mesa de ${r.ativo.simbolo}.` : `${r.ativo.mercado} está fechado. Espero abrir.`, 1.8);
  }

  /** Manda descansar. Em reunião ou indo ao chefe, sai quando voltar para a mesa. */
  function dispensar(r) {
    if (r.estado === 'folga' || r.estado === 'indo_folga') return;
    if (ocupado(r)) {
      r.folgaPedida = true;
      falar(r, 'Termino esta e já saio de folga.', 1.8);
      return;
    }
    if (!aoVivo && r.carteira.quantidade > 0) zerarParaDescansar(r);
    r.descanso = lugarLivre(D.VAGAS_MESA[r.vaga].x < 640 ? 'esq' : 'dir');
    const caminho = caminhoAteDescanso(r);
    r.vaga = null;
    r.estado = 'indo_folga';
    r.digitando = false;
    r.emocao = 'feliz';
    r.antena = ANTENA.folga;
    falar(r, ['Hora do café!', 'Folga merecida.', 'Até mais, pessoal!'][Math.floor(mercado.rand() * 3)], 1.6);
    irPara(r, caminho, () => {
      r.estado = 'folga';
      acomodarNoDescanso(r);
    });
  }

  /** Quem sai de folga não deixa posição aberta sem ninguém olhando: vende antes (fictício). */
  function zerarParaDescansar(r) {
    const preco = r.ativo.preco;
    const { resultado } = executar(r.carteira, 'venda', preco);
    const entrada = {
      hora: `dia ${mercado.relogio.dia} · ${mercado.horaTexto()}`,
      robo: r,
      proposta: { lado: 'venda', preco, motivo: 'zerou a posição antes da folga', confianca: 1 },
      verificacao: { itens: [], nota: 1 },
      decisao: { aprovado: true, combinada: 1, motivo: 'saída para descanso, sem reunião' },
      execucao: { preco, resultado },
    };
    registro.unshift(entrada);
    if (registro.length > 60) registro.pop();
    desenharRegistro();
    falar(r, `Zerei ${r.ativo.simbolo} antes da folga: ${resultado >= 0 ? '+' : ''}${resultado.toFixed(2)}.`, 2.2);
  }

  const lembrarEscala = () => !aoVivo && salvarEscala(robos.filter((r) => naMesa(r) && !r.folgaPedida).map((r) => r.id));
  const AVISO_AO_VIVO = 'Ao vivo, quem trabalha são as estratégias ativas: ligue ou desligue em Estratégias.';

  /** Põe para trabalhar exatamente estes robôs (até onde houver mesa) e manda os outros descansar. */
  function aplicarEscala(ids) {
    if (aoVivo) return avisoEscala(AVISO_AO_VIVO);
    const alvo = new Set(ids);
    for (const r of robos) if (!alvo.has(r.id)) dispensar(r);
    const semMesa = robos.filter((r) => alvo.has(r.id) && !escalar(r));
    lembrarEscala();
    avisoEscala(semMesa.length ? `Só cabem ${D.VAGAS_MESA.length} na mesa: ${semMesa.map((r) => r.nome).join(', ')} ficou de folga.` : '');
    desenharEscala();
  }

  /** Liga ou desliga um robô (botão da escala ou do cartão). */
  function alternarRobo(r) {
    if (aoVivo) {
      avisoEscala(AVISO_AO_VIVO);
      return;
    }
    if (r.folgaPedida) r.folgaPedida = false;
    else if (naMesa(r)) dispensar(r);
    else if (!escalar(r)) {
      avisoEscala(`As ${D.VAGAS_MESA.length} mesas estão ocupadas: mande alguém descansar primeiro.`);
      return;
    }
    avisoEscala('');
    lembrarEscala();
    desenharEscala();
    desenharCartoes();
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
    r.respostasIa = undefined;
    r.consultaIa = conselhoLigado && !proposta.real
      ? opcoes
          .consultarIa({
            simbolo: r.ativo.simbolo,
            lado: proposta.lado,
            cotacao: proposta.preco,
            ...(proposta.lado === 'compra' ? { valor: VALOR_POR_ORDEM } : r.carteira.quantidade > 0 ? { quantidade: r.carteira.quantidade } : {}),
            contexto: `Escritório virtual com dados FICTÍCIOS. Proposta do robô analista: ${proposta.motivo}. Confiança do analista ${pct(proposta.confianca)}.`,
            extras: {
              media_9: proposta.indicadores?.curta ?? null,
              media_26: proposta.indicadores?.longa ?? null,
              ifr_14: proposta.indicadores?.ifr ?? null,
              volatilidade_dia: r.ativo.volDia,
            },
          })
          .then((x) => (r.respostasIa = x))
          .catch((e) => (r.respostasIa = [{ ok: false, conector: 'IAs', erro: e.message, ms: 0 }]))
      : null;
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
    // o conselho de IAs ainda não respondeu: o chefe espera (no máximo o tempo das IAs)
    if (r.consultaIa && r.respostasIa === undefined) {
      chefe.emocao = 'pensando';
      falar(chefe, 'Um momento: consultando o conselho de IAs…', 2.4, { deslocX: 120 });
      r.consultaIa.finally(() => comecarReuniao(r));
      r.consultaIa = null;
      return;
    }
    const p = r.proposta;
    // ao vivo, a decisão é a que o bot tomou: a reunião só encena
    const verificacao = p.real ? p.verificacao : verificarChefe(p, r.ativo, r.carteira, posicoesAbertas());
    const decisao = p.real ? p.decisao : aplicarConselho(decidirJuntos(p, verificacao), r.respostasIa, !p.urgente);
    // linha do tempo da reunião (segundos desde o começo): o analista fala, o holograma abre, os
    // itens do chefe aparecem um a um, as notas, o carimbo e o holograma fecha antes das respostas
    const itens = 2.9;
    const passo = 0.55;
    const notas = itens + verificacao.itens.length * passo + 0.3;
    const carimbo = notas + 0.7;
    const tempos = { abrir: 2.2, itens, passo, notas, carimbo, fechar: carimbo + 1.5 };
    const reuniao = { robo: r, proposta: p, verificacao, decisao, desde: tempo, tempos, rodape: p.rodape };
    chefe.reuniao = reuniao;
    chefe.emocao = 'pensando';
    chefe.olharX = -0.9;

    const lado = p.lado === 'compra' ? 'COMPRA' : 'VENDA';
    falar(
      r,
      `Proposta: ${lado} ${r.ativo.simbolo} a ${formatarPreco(r.ativo, p.preco)}.\n${p.motivo}.${p.real ? '' : ` Confiança ${pct(p.confianca)}.`}`,
      2.1,
      { deslocX: -110 },
    );

    const tNotas = tempos.notas;
    const tCarimbo = tempos.carimbo;
    agendar(chefe, tNotas, () => {
      const c = decisao.conselho;
      if (p.real) {
        const aFavor = verificacao.itens.filter((i) => i.ok).length;
        return falar(chefe, `Conferi: ${aFavor} de ${verificacao.itens.length} a favor.`, 1.8, { deslocX: 120 });
      }
      falar(chefe, `Minha nota: ${pct(verificacao.nota)}. Juntos: ${pct(decisao.combinada)}.${c ? `\nIAs: ${c.aprovacoes} a favor, ${c.vetos} contra.` : ''}`, 1.8, { deslocX: 120 });
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
      falar(chefe, p.real ? p.falaChefe : decisao.aprovado ? 'Aprovado. Pode executar.' : `Não agora: ${decisao.motivo}.`, 2.4, { deslocX: 120 });
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
      // ao vivo, a ordem já foi executada pelo bot: aqui só se mostra (a posição vem do servidor)
      const preco = p.real ? p.preco : r.ativo.preco;
      const { resultado } = p.real ? { resultado: Number.NaN } : executar(r.carteira, p.lado, preco);
      r.carteira.aprovadas++;
      const lado = p.lado === 'compra' ? 'COMPRADO' : 'VENDIDO';
      r.flash = { texto: lado, cor: 'rgba(61, 220, 132, ALFA)', ate: tempo + 1.6, duracao: 1.6 };
      const mesa = D.VAGAS_MESA[r.vaga];
      const monitorX = mesa.x - r.lado * 38 * D.escalaEm(mesa.y);
      if (p.lado === 'venda' && (resultado > 0 || (p.real && p.preco > r.carteira.precoEntrada))) soltarParticulas(monitorX, mesa.y - 120, 'moeda', 14);
      else soltarParticulas(monitorX, mesa.y - 120, 'faisca', 16, p.lado === 'venda' ? '#ff9f68' : '#3ddc84');
      const texto = p.real && !p.ordem
        ? `Avisei o dono: ${p.lado === 'compra' ? 'comprar' : 'vender'} na XP.`
        : p.real
        ? `${p.lado === 'compra' ? 'Comprei' : 'Vendi'} a ${formatarPreco(r.ativo, preco)} (${p.ordem?.modo === 'real' ? 'ordem real' : 'simulação'}).`
        : p.lado === 'compra'
          ? `Comprei a ${formatarPreco(r.ativo, preco)}.`
          : `Vendi a ${formatarPreco(r.ativo, preco)}: ${resultado >= 0 ? 'lucro' : 'prejuízo'} de ${formatarPreco({ ...r.ativo, casas: 2 }, Math.abs(resultado))}.`;
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
    if (r.folgaPedida) agendar(r, 2.4, () => r.folgaPedida && dispensar(r));
  }

  function forcarSinal(r) {
    if (aoVivo) return;
    if (r.estado !== 'trabalhando') {
      falar(r, r.estado === 'dormindo' ? 'O mercado está fechado agora.' : r.estado === 'folga' ? 'Estou de folga hoje!' : 'Já estou ocupado!', 1.6);
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
    if (aoVivo) {
      // ao vivo ninguém inventa sinal: o robô leva ao chefe os sinais que o bot recebeu
      for (const r of robos) if (r.estado === 'trabalhando' && r.filaSinais.length) iniciarProposta(r, r.filaSinais.shift());
      return;
    }
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

  function conversaDescanso() {
    const deFolga = robos.filter((x) => x.estado === 'folga' && (!x.fala || x.fala.ate < tempo));
    if (!deFolga.length) return;
    const r = deFolga[Math.floor(mercado.rand() * deFolga.length)];
    const frases = r.caneca
      ? ['Esse café está ótimo.', `Como está o ${robos.find((x) => naMesa(x))?.ativo.simbolo ?? 'mercado'} hoje?`, 'Pausa estratégica.']
      : ['Zzz…', 'Só mais cinco minutinhos…', `Sonhando com ${r.ativo.simbolo} subindo…`];
    falar(r, frases[Math.floor(mercado.rand() * frases.length)], 2.2);
  }

  function conversaToa() {
    const livres = robos.filter((r) => r.estado === 'trabalhando' && (!r.fala || r.fala.ate < tempo));
    if (!livres.length) return;
    const r = livres[Math.floor(mercado.rand() * livres.length)];
    const indice = ifr(r.ativo.historico);
    const v = r.ativo.variacaoDia * 100;
    if (aoVivo) {
      const e = r.ativo.estrategia;
      const frasesReais = [
        `${r.ativo.simbolo} ${v >= 0 ? '+' : ''}${v.toFixed(2)}% hoje.`,
        indice === null ? 'Lendo as velas…' : `IFR diário em ${indice.toFixed(0)}.`,
        r.carteira.quantidade > 0 ? `Posição aberta desde ${formatarPreco(r.ativo, r.carteira.precoEntrada)}.` : e.auto_ligado ? 'Sem posição. O piloto espera a virada.' : 'Sem posição. Esperando sinal do webhook.',
      ];
      const motivo = motivoDoRobo(r.ativo);
      if (e.auto_ligado && motivo) frasesReais.push(motivo.length > 90 ? `${motivo.slice(0, 89)}…` : motivo);
      if (r.ativo.olheiro) frasesReais.splice(2, 1, r.ativo.par?.virou ? 'Virou para alta! Vou levar ao chefe.' : 'De olho. Ainda não virou.');
      falar(r, frasesReais[Math.floor(mercado.rand() * frasesReais.length)], 2.8);
      return;
    }
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
      hora: reuniao.proposta.real ? horaDoSinal({ recebido_em: reuniao.proposta.quando }) : `dia ${mercado.relogio.dia} · ${mercado.horaTexto()}`,
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
  // escala do dia: um botão por robô, agrupados por mercado, e atalhos
  const textoAviso = h('p', { class: 'rotulo escala-aviso', hidden: true });
  const contador = h('span', { class: 'rotulo' });
  const botoesRobo = new Map();
  const ATALHOS = [
    ['Só cripto', () => robos.filter((r) => r.ativo.categoria === 'cripto')],
    ['Só B3', () => robos.filter((r) => r.ativo.categoria === 'b3')],
    ['Brasil', () => robos.filter((r) => ['b3', 'cambio'].includes(r.ativo.categoria))],
    ['Lotar as mesas', () => robos.slice(0, D.VAGAS_MESA.length)],
    ['Todos de folga', () => []],
  ];
  const painelEscala = h(
    'section',
    { class: 'escala' },
    h('div', { class: 'escritorio-cartao-topo' }, h('strong', {}, aoVivo ? 'Quem está trabalhando' : 'Escala de hoje'), contador),
    aoVivo ? null : h('div', { class: 'acoes' }, ATALHOS.map(([nome, quem]) => h('button', { class: 'pequeno secundario', onclick: () => aplicarEscala(quem().map((r) => r.id)) }, nome))),
    (aoVivo ? [{ id: 'real', nome: 'Suas estratégias (ativas na mesa)' }] : CATEGORIAS).map((cat) =>
      h('div', { class: 'escala-grupo' },
        h('span', { class: 'rotulo' }, cat.nome),
        h('div', { class: 'escala-robos' }, robos.filter((r) => r.ativo.categoria === cat.id).map((r) => {
          const b = h('button', { class: 'escala-robo', title: `${aoVivo ? r.ativo.nome : r.nome} · ${r.ativo.simbolo}`, onclick: () => alternarRobo(r) }, h('i', {}), aoVivo ? (r.ativo.olheiro ? r.ativo.simbolo : r.ativo.nome) : r.nome);
          b.style.setProperty('--cor', r.cor);
          botoesRobo.set(r, b);
          return b;
        })))),
    textoAviso,
  );
  let avisoAte = 0;
  function avisoEscala(texto) {
    textoAviso.textContent = texto;
    textoAviso.hidden = !texto;
    avisoAte = texto ? performance.now() + 6000 : 0;
  }
  function desenharEscala() {
    const ocupadas = robos.filter(naMesa).length;
    contador.textContent = `${ocupadas}/${D.VAGAS_MESA.length} mesas`;
    for (const [r, b] of botoesRobo) {
      const trabalhando = naMesa(r) && !r.folgaPedida;
      b.classList.toggle('ligado', trabalhando);
      b.classList.toggle('andando', r.estado === 'indo_mesa' || r.estado === 'indo_folga' || Boolean(r.folgaPedida));
      b.setAttribute('aria-pressed', String(trabalhando));
    }
    if (avisoAte && performance.now() > avisoAte) avisoEscala('');
  }

  // ao vivo: um quadro compacto (uma linha por robô) no lugar dos cartões grandes
  const contadorQuadro = h('span', { class: 'rotulo' });
  const listaQuadro = h('div', { class: 'quadro-robos-lista' });
  const quadroRobos = h('section', { class: 'quadro-robos' },
    h('div', { class: 'escritorio-cartao-topo' }, h('strong', {}, 'Robôs'), contadorQuadro),
    listaQuadro,
    textoAviso);

  const lateral = h(
    'aside',
    { class: 'escritorio-lado' },
    h('div', { class: 'acoes' }, botaoPausa, ...botoesVel, botaoTela),
    aoVivo
      ? h('p', { class: 'rotulo' }, 'Cada robô é uma estratégia sua (ou uma moeda que o piloto está olhando), com o preço real. Toque numa linha para ver o motivo. Cada sinal vira uma reunião com o chefe.')
      : h('p', { class: 'rotulo' }, 'Dados fictícios: nenhuma ordem de verdade sai desta tela. Escolha quem trabalha hoje; quem fica de folga vai para a sala de descanso. Clique num robô para ver os detalhes.'),
    podeConselho && !aoVivo
      ? h('label', { class: 'interruptor escritorio-conselho-botao' },
          h('input', { type: 'checkbox', onchange: (ev) => (conselhoLigado = ev.target.checked) }),
          h('span', { class: 'interruptor-trilho' }, h('span', { class: 'interruptor-bola' })),
          h('span', { class: 'interruptor-texto' }, h('span', {}, 'Conselho de IAs na reunião'), h('small', { class: 'rotulo' }, 'consulta as IAs de verdade em cada proposta (gasta créditos); elas só podem vetar')))
      : null,
    aoVivo ? quadroRobos : painelEscala,
    aoVivo ? null : h('div', { class: 'escritorio-cartoes' }, cartoes.map((c) => c.el)),
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

  let ultimaAssinatura = '';
  /** Ao vivo: o quadro de linhas, com quem tem posição e quem tem sinal primeiro. */
  function desenharQuadro() {
    const linhas = robos.map((r) => {
      const e = r.ativo.estrategia;
      const c = r.carteira;
      const temPosicao = !r.ativo.olheiro && c.quantidade > 0;
      const variacaoPosicao = temPosicao && c.precoEntrada && !r.ativo.semCotacao ? r.ativo.preco / c.precoEntrada - 1 : 0;
      const motivo = motivoDoRobo(r.ativo);
      const [texto, tipo] = ['indo', 'fila', 'reuniao'].includes(r.estado) ? ['com o chefe', 'alerta'] : situacaoCurta(motivo, { ativa: e.ativa, temPosicao, variacaoPosicao, olheiro: r.ativo.olheiro });
      const peso = temPosicao ? 0 : tipo === 'ok' || tipo === 'alerta' ? 1 : e.ativa ? 2 : 3;
      return { r, e, c, motivo, texto, tipo, peso, temPosicao };
    });
    linhas.sort((a, b) => a.peso - b.peso || a.r.ativo.simbolo.localeCompare(b.r.ativo.simbolo));
    // só refaz a lista quando algo visível mudou (refazer a cada meio segundo engole toques)
    const assinatura = JSON.stringify([selecionado?.id ?? null, ...linhas.map((l) => [l.r.id, l.texto, l.motivo, l.r.ativo.preco, l.r.ativo.variacaoDia])]);
    if (assinatura === ultimaAssinatura) return;
    ultimaAssinatura = assinatura;
    contadorQuadro.textContent = `${robos.filter(naMesa).length}/${D.VAGAS_MESA.length} mesas · ${linhas.filter((l) => l.temPosicao).length} com posição`;
    listaQuadro.replaceChildren(...linhas.map(({ r, e, c, motivo, texto, tipo, temPosicao }) => {
      const nome = r.ativo.olheiro ? r.ativo.simbolo.split('/')[0] : e.nome.replace(/^Piloto /, '');
      const v = r.ativo.variacaoDia * 100;
      const linha = h('button', { class: `linha-robo ${r === selecionado ? 'aberta' : ''}`, type: 'button', onclick: () => selecionar(r), title: motivo ?? '' },
        h('i', {}),
        h('span', { class: 'linha-robo-nome' }, nome, r.ativo.olheiro ? h('small', {}, ' olheiro') : null),
        h('span', { class: 'mono linha-robo-preco' }, r.ativo.semCotacao ? '—' : formatarPreco(r.ativo, r.ativo.preco)),
        h('span', { class: `mono linha-robo-var ${v >= 0 ? 'ok' : 'perigo-txt'}` }, r.ativo.semCotacao ? '' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`),
        h('span', { class: `selo-mini ${tipo}` }, texto));
      linha.style.setProperty('--cor', r.cor);
      if (r !== selecionado) return linha;
      const detalhe = h('div', { class: 'linha-robo-detalhe' },
        h('div', { class: 'rotulo' }, r.ativo.olheiro
          ? `${r.ativo.simbolo}: o piloto de "${e.nome}" está de olho neste par`
          : `${e.nome} · ${r.ativo.simbolo} · ${e.operando_real ? 'dinheiro REAL' : 'simulação'}${temPosicao ? ` · posição desde ${formatarPreco(r.ativo, c.precoEntrada)}` : ''}`),
        h('div', { class: 'rotulo' }, e.auto_ligado ? `Piloto: ${motivo ?? 'aguardando a primeira passada'}` : 'Piloto desligado: só age com sinal do webhook ou pelos botões'),
        h('div', { class: 'acoes' }, h('button', { class: 'pequeno secundario', type: 'button', onclick: () => (location.hash = '#/estrategias') }, 'Comprar ou vender em Estratégias')));
      return h('div', { class: 'linha-robo-caixa' }, linha, detalhe);
    }));
  }

  function desenharCartoes() {
    if (aoVivo) return desenharQuadro();
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
        indo_mesa: 'indo para a mesa',
        indo_folga: 'indo descansar',
        folga: 'de folga',
      }[r.estado];
      el.hidden = r.estado === 'folga' && r !== selecionado;
      if (aoVivo) {
        const e = r.ativo.estrategia;
        el.hidden = false;
        const motivo = motivoDoRobo(r.ativo);
        const linhas = [
          h('div', { class: 'escritorio-cartao-topo' },
            h('strong', {}, r.ativo.olheiro ? `${r.ativo.simbolo} · olheiro` : `${e.nome} · ${r.ativo.simbolo}`),
            h('span', { class: 'rotulo' }, e.ativa ? (r.ativo.par?.virou ? 'virou para alta' : estado) : 'parada')),
          r.ativo.semCotacao
            ? h('div', { class: 'rotulo' }, `sem cotação da ${r.ativo.mercado} agora`)
            : h('div', { class: 'mono' }, formatarPreco(r.ativo, r.ativo.preco), ' ', h('span', { class: r.ativo.variacaoDia >= 0 ? 'ok' : 'perigo-txt' }, `${r.ativo.variacaoDia >= 0 ? '+' : ''}${(r.ativo.variacaoDia * 100).toFixed(2)}% hoje`)),
          r.ativo.olheiro ? h('div', { class: 'rotulo' }, `o piloto de "${e.nome}" está de olho neste par`) : h('div', { class: 'rotulo' },
            `${e.operando_real ? 'dinheiro REAL' : 'simulação'} · ${c.quantidade > 0 ? `posição desde ${formatarPreco(r.ativo, c.precoEntrada)}${r.ativo.semCotacao ? '' : ` (${mtm >= 0 ? '+' : ''}${mtm.toFixed(2)})`}` : 'sem posição'}`),
          e.auto_ligado ? h('div', { class: 'rotulo' }, `Piloto: ${motivo ?? 'aguardando a primeira passada'}`) : h('div', { class: 'rotulo' }, 'Piloto desligado: só age com sinal do webhook'),
        ];
        if (r === selecionado) {
          linhas.push(h('div', { class: 'acoes' }, h('button', { class: 'pequeno secundario', onclick: (ev) => { ev.stopPropagation(); location.hash = '#/estrategias'; } }, 'Abrir em Estratégias')));
        }
        el.classList.toggle('selecionado', r === selecionado);
        el.replaceChildren(...linhas);
        continue;
      }
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
          h('div', { class: 'acoes' },
            h('button', { class: 'pequeno', disabled: !aberto || r.estado !== 'trabalhando', onclick: (ev) => { ev.stopPropagation(); forcarSinal(r); } }, 'Forçar sinal'),
            naMesa(r)
              ? h('button', { class: 'pequeno secundario', onclick: (ev) => { ev.stopPropagation(); alternarRobo(r); } }, r.folgaPedida ? 'Folga pedida' : 'Mandar descansar')
              : h('button', { class: 'pequeno secundario', onclick: (ev) => { ev.stopPropagation(); alternarRobo(r); } }, 'Chamar para trabalhar')),
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
            h('strong', {}, `${aoVivo ? (e.robo.ativo.olheiro ? 'olheiro' : e.robo.ativo.nome) : e.robo.nome}: ${lado} ${p.simboloDoSinal ?? e.robo.ativo.simbolo}`),
            h('span', { class: `selo ${e.decisao.aprovado ? 'ok' : 'perigo-txt'}` }, e.decisao.aprovado ? 'aprovado' : 'reprovado'),
          ),
          h('div', { class: 'rotulo' }, `${e.hora} · ${formatarPreco(e.robo.ativo, p.preco)} · ${p.motivo}`),
          h('div', { class: 'rotulo' }, p.real ? `${p.rodape} · ${e.decisao.motivo}` : `analista ${pct(p.confianca)} · chefe ${pct(e.verificacao.nota)} · juntos ${pct(e.decisao.combinada)} · ${e.decisao.motivo}`),
          h('ul', { class: 'escritorio-itens' }, e.verificacao.itens.map((i) => h('li', { class: i.ok ? 'ok' : 'perigo-txt' }, `${i.ok ? '✔' : '✖'} ${i.texto}`))),
          e.decisao.conselho
            ? h('ul', { class: 'escritorio-itens escritorio-conselho' }, e.decisao.conselho.respostas.map((x) =>
                x.ok
                  ? h('li', { class: x.parecer.decisao === 'aprovar' ? 'ok' : 'perigo-txt' }, `${x.parecer.decisao === 'aprovar' ? '✔' : '✖'} IA ${x.conector} (${pct(x.parecer.confianca)}): ${x.parecer.motivo}`)
                  : h('li', { class: 'rotulo' }, `… IA ${x.conector} falhou: ${x.erro}`)))
            : null,
          e.execucao
            ? h('div', { class: 'rotulo' }, `executado a ${formatarPreco(e.robo.ativo, e.execucao.preco)}${p.lado === 'venda' && Number.isFinite(e.execucao.resultado) ? ` · resultado ${e.execucao.resultado >= 0 ? '+' : ''}${e.execucao.resultado.toFixed(2)}` : ''}`)
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
      if (mercado.rand() < 0.3) conversaDescanso();
      else conversaToa();
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
    D.VAGAS_MESA.forEach((vaga, i) => {
      const dono = robos.find((r) => r.vaga === i);
      itens.push({ y: vaga.y, desenhar: () => D.desenharMesa(ctx, vaga, dono?.ativo ?? null, dono, tempo, dono ? mercado.aberto(dono.ativo) : false) });
    });
    for (const r of robos) itens.push({ y: r.y, desenhar: () => desenharRoboNaPosicao(r) });
    itens.sort((a, b) => a.y - b.y);
    for (const it of itens) it.desenhar();

    D.desenharLuz(ctx, luz, tempo);
    const reuniao = chefe.reuniao;
    if (reuniao) D.desenharHolograma(ctx, reuniao, tempo, reuniao.robo.ativo);
    D.desenharParticulas(ctx, particulas);
    for (const r of [...robos, chefe]) D.desenharBalao(ctx, comoDesenho(r), tempo);

    // selo de simulação
    ctx.fillStyle = aoVivo ? 'rgba(34, 160, 92, 0.94)' : 'rgba(178, 107, 0, 0.92)';
    ctx.beginPath();
    ctx.roundRect(14, 12, aoVivo ? 196 : 238, 24, 6);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(aoVivo ? '● AO VIVO · DADOS REAIS' : 'SIMULAÇÃO · DADOS FICTÍCIOS', 26, 28);
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
      desenharEscala();
      proximaAtualizacaoDom = agora + 500;
    }
    rafId = requestAnimationFrame(quadro);
  }
  rafId = requestAnimationFrame(quadro);

  // ---------------------------------------------------------------- ao vivo: dados do servidor

  /** Quem leva o sinal ao chefe: na compra, o olheiro do par (quem achou); senão, o robô da estratégia. */
  function roboDa(s) {
    const daEstrategia = robos.filter((r) => r.ativo.estrategiaId === s.estrategia_id);
    const olheiro = s.acao === 'comprar' && s.simbolo ? daEstrategia.find((r) => r.ativo.olheiro && r.ativo.simbolo === s.simbolo) : null;
    return olheiro ?? daEstrategia.find((r) => !r.ativo.olheiro) ?? null;
  }

  /** Sinal que chega com o robô descansando (estratégia parada) vai direto para o registro. */
  function registrarSemReuniao(r, proposta) {
    const entrada = { hora: horaDoSinal({ recebido_em: proposta.quando }), robo: r, proposta, verificacao: proposta.verificacao, decisao: proposta.decisao, execucao: proposta.decisao.aprovado ? { preco: proposta.preco, resultado: Number.NaN } : null };
    registro.unshift(entrada);
    if (registro.length > 60) registro.pop();
  }

  function aplicarDados(d, primeiraVez = false) {
    mercado.atualizar(d);
    for (const r of robos) {
      const e = r.ativo.estrategia;
      if (!r.ativo.olheiro) {
        carteiraDa(e, r.carteira);
        r.nome = r.ativo.simbolo.split('/')[0];
      }
      if (primeiraVez) continue;
      if (e.ativa && r.estado === 'folga') escalar(r);
      else if (!e.ativa && naMesa(r) && !ocupado(r)) dispensar(r);
    }
    const novos = [...d.sinais].sort((a, b) => a.id - b.id).filter((s) => s.id > ultimoSinal);
    for (const s of novos) {
      const r = roboDa(s);
      ultimoSinal = Math.max(ultimoSinal, s.id);
      if (!r) continue;
      const proposta = propostaDoSinal(s, r.ativo);
      // os que já existiam ao abrir a tela entram no registro; os novos viram reunião
      if (primeiraVez || !naMesa(r)) registrarSemReuniao(r, proposta);
      else r.filaSinais.push(proposta);
    }
    desenharRegistro();
  }

  let intervaloAoVivo = 0;
  if (aoVivo) {
    aplicarDados(aoVivo.dados, true);
    intervaloAoVivo = setInterval(() => {
      const minha = ++buscaId;
      aoVivo.buscar().then((d) => minha === buscaId && aplicarDados(d)).catch(() => undefined);
    }, INTERVALO_AO_VIVO_MS);
  }

  return {
    parar() {
      cancelAnimationFrame(rafId);
      observador.disconnect();
      clearInterval(intervaloAoVivo);
    },
    // para testes e demonstração
    _estado: { robos, chefe, mercado, registro, forcarSinal, definirVelocidade, aplicarEscala, alternarRobo, aplicarDados: aoVivo ? aplicarDados : null },
  };
}
