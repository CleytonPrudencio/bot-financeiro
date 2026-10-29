// Base do painel: montagem do DOM, ícones, API, avisos, janelas e formatação.
// Sem framework e sem build. Tudo é montado com h()/s(), que só usam textContent e atributos:
// nada que venha do banco, de um sinal ou de uma IA vira HTML.

export const $ = (s, raiz = document) => raiz.querySelector(s);
export const reduzido = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function anexar(el, filhos) {
  for (const f of filhos.flat(Infinity)) {
    if (f === undefined || f === null || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
}

export function h(tag, attrs = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'estilo') for (const [p, valor] of Object.entries(v)) el.style.setProperty(p, valor);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  anexar(el, filhos);
  return el;
}

const NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...filhos) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'estilo') for (const [p, valor] of Object.entries(v)) el.style.setProperty(p, valor);
    else el.setAttribute(k, String(v));
  }
  anexar(el, filhos);
  return el;
}

// ------------------------------------------------------------------ ícones (traço 24x24)

const ICONES = {
  painel: ['M4 4h7v7H4z', 'M13 4h7v4h-7z', 'M13 10h7v10h-7z', 'M4 13h7v7H4z'],
  escritorio: ['M4 21V8l8-5 8 5v13', 'M9 21v-6h6v6', 'M8 10h.01M12 10h.01M16 10h.01'],
  estrategias: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 12h.01', 'M21 3l-7 7'],
  contas: ['M3 7h18v12H3z', 'M3 7l2-3h14l2 3', 'M16 13h2'],
  ias: ['M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z', 'M5 16l.6 1.4L7 18l-1.4.6L5 20l-.6-1.4L3 18l1.4-.6z'],
  sinais: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  ordens: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6M9 12h6M9 16h3'],
  auditoria: ['M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z', 'M8.5 12l2.5 2.5 4.5-5'],
  sair: ['M15 4h4v16h-4', 'M10 8l-4 4 4 4', 'M6 12h10'],
  sol: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'],
  lua: ['M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z'],
  mais: ['M12 5v14M5 12h14'],
  editar: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  testar: ['M7 4l13 8-13 8z'],
  chave: ['M14 10a4 4 0 1 0-1.2 2.8L20 20', 'M17 17l2-2', 'M15 19l1.5-1.5'],
  copiar: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  fechar: ['M6 6l12 12M18 6L6 18'],
  alerta: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5h.01'],
  ok: ['M5 12.5l4.5 4.5L19 7.5'],
  energia: ['M12 2v10', 'M6.3 5.7a8 8 0 1 0 11.4 0'],
  atualizar: ['M20 11a8 8 0 0 0-14.6-4.5L4 8', 'M4 3v5h5', 'M4 13a8 8 0 0 0 14.6 4.5L20 16', 'M20 21v-5h-5'],
  busca: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  relogio: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  robo: ['M5 9h14v10H5z', 'M12 5v4', 'M12 4h.01', 'M9 13h.01M15 13h.01', 'M9.5 16.5h5', 'M3 13v2M21 13v2'],
  cotacao: ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'],
  apagar: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  pausar: ['M8 5v14M16 5v14'],
  enviar: ['M4 12l16-8-6 16-2.5-6.5z', 'M11.5 13.5L20 4'],
  escudo: ['M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z'],
  seta: ['M9 6l6 6-6 6'],
  compra: ['M12 19V5', 'M6 11l6-6 6 6'],
  venda: ['M12 5v14', 'M6 13l6 6 6-6'],
  analise: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2', 'M19 4l-3 3 3 3'],
  usuario: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
};

export function icone(nome, classe = '') {
  return s(
    'svg',
    { class: `ic ${classe}`, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    (ICONES[nome] ?? ICONES.painel).map((d) => s('path', { d })),
  );
}

export function marca() {
  return s(
    'svg',
    { class: 'marca-icone', viewBox: '0 0 32 32', 'aria-hidden': 'true' },
    s('defs', {}, s('linearGradient', { id: 'g-marca', x1: 0, y1: 0, x2: 1, y2: 1 }, s('stop', { offset: '0', 'stop-color': '#3b82f6' }), s('stop', { offset: '1', 'stop-color': '#22d3ee' }))),
    s('rect', { x: 1, y: 1, width: 30, height: 30, rx: 9, fill: 'url(#g-marca)' }),
    s('path', { d: 'M7 21l5-6 4 3 7-9', fill: 'none', stroke: '#fff', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    s('circle', { cx: 23, cy: 9, r: 2.2, fill: '#fde68a' }),
  );
}

// ------------------------------------------------------------------ API

let aoExpirar = () => {};
export function quandoSessaoExpirar(fn) {
  aoExpirar = fn;
}

export async function api(metodo, caminho, corpo) {
  const r = await fetch('/api' + caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json', 'x-painel': '1' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const dados = await r.json().catch(() => ({}));
  if (r.status === 401 && caminho !== '/login') {
    aoExpirar();
    throw new Error('sessão expirou');
  }
  if (!r.ok) throw new Error(dados.erro ?? `erro ${r.status}`);
  return dados;
}

// ------------------------------------------------------------------ avisos (toasts)

export function avisar(texto, tipo = 'ok') {
  const pilha = $('#avisos');
  const duracao = tipo === 'erro' ? 7000 : 3800;
  const el = h(
    'div',
    { class: `aviso aviso-${tipo}`, role: tipo === 'erro' ? 'alert' : 'status' },
    icone(tipo === 'erro' ? 'alerta' : tipo === 'info' ? 'relogio' : 'ok'),
    h('span', {}, texto),
    h('button', { class: 'aviso-fechar', 'aria-label': 'Fechar', onclick: () => sair() }, icone('fechar')),
    h('i', { class: 'aviso-barra', estilo: { 'animation-duration': `${duracao}ms` } }),
  );
  const sair = () => {
    el.classList.add('saindo');
    setTimeout(() => el.remove(), 250);
  };
  pilha.append(el);
  setTimeout(sair, duracao);
}

/** Roda uma ação e mostra o erro, se houver. */
export async function tentar(fn, sucesso) {
  try {
    const r = await fn();
    if (sucesso) avisar(sucesso);
    return r;
  } catch (e) {
    if (e.message !== 'sessão expirou') avisar(e.message, 'erro');
    return undefined;
  }
}

// ------------------------------------------------------------------ janelas

export function janela(titulo, { subtitulo, largura, icone: nomeIcone } = {}, ...corpo) {
  const d = h(
    'dialog',
    { class: `janela ${largura ? `janela-${largura}` : ''}` },
    h(
      'header',
      { class: 'janela-topo' },
      nomeIcone ? h('span', { class: 'janela-icone' }, icone(nomeIcone)) : null,
      h('div', {}, h('h2', {}, titulo), subtitulo ? h('p', { class: 'suave' }, subtitulo) : null),
      h('button', { class: 'botao-icone', 'aria-label': 'Fechar', onclick: () => fechar() }, icone('fechar')),
    ),
    h('div', { class: 'janela-corpo' }, ...corpo),
  );
  const fechar = () => {
    if (!d.open) return;
    d.classList.add('fechando');
    setTimeout(() => d.close(), reduzido() ? 0 : 160);
  };
  d.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    fechar();
  });
  d.addEventListener('click', (ev) => {
    if (ev.target === d) fechar();
  });
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  d.fechar = fechar;
  return d;
}

/** Confirmação estilizada (substitui o confirm do navegador). Resolve true/false. */
export function confirmar(titulo, texto, { perigo = false, botao = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    let respondeu = false;
    const responder = (v) => {
      respondeu = true;
      resolve(v);
      d.fechar();
    };
    const d = janela(
      titulo,
      { icone: perigo ? 'alerta' : 'escudo' },
      h('p', { class: 'confirmar-texto' }, texto),
      h(
        'div',
        { class: 'acoes acoes-fim' },
        h('button', { class: 'botao secundario', onclick: () => responder(false) }, 'Cancelar'),
        h('button', { class: `botao ${perigo ? 'perigo' : ''}`, onclick: () => responder(true) }, botao),
      ),
    );
    d.classList.add(perigo ? 'janela-perigo' : 'janela-confirmar');
    d.addEventListener('close', () => respondeu || resolve(false));
  });
}

// ------------------------------------------------------------------ formulários

export function campo(rotulo, attrs, dica) {
  return h('label', { class: 'campo' }, h('span', { class: 'campo-rotulo' }, rotulo), h('input', attrs), dica ? h('small', { class: 'campo-dica' }, dica) : null);
}

export function escolha(rotulo, nome, opcoes, atual, dica) {
  return h(
    'label',
    { class: 'campo' },
    h('span', { class: 'campo-rotulo' }, rotulo),
    h('select', { name: nome }, opcoes.map(([valor, texto]) => h('option', { value: valor, selected: String(atual) === String(valor) }, texto))),
    dica ? h('small', { class: 'campo-dica' }, dica) : null,
  );
}

export function areaTexto(rotulo, attrs, dica) {
  const { value, ...resto } = attrs;
  const t = h('textarea', resto);
  if (value) t.value = value;
  return h('label', { class: 'campo campo-largo' }, h('span', { class: 'campo-rotulo' }, rotulo), t, dica ? h('small', { class: 'campo-dica' }, dica) : null);
}

/** Interruptor (checkbox estilizado). */
export function interruptor(rotulo, attrs, dica) {
  return h(
    'label',
    { class: 'interruptor' },
    h('input', { type: 'checkbox', ...attrs }),
    h('span', { class: 'interruptor-trilho' }, h('span', { class: 'interruptor-bola' })),
    h('span', { class: 'interruptor-texto' }, h('span', {}, rotulo), dica ? h('small', { class: 'campo-dica' }, dica) : null),
  );
}

export function secao(titulo, ...filhos) {
  return h('fieldset', { class: 'secao-form' }, h('legend', {}, titulo), h('div', { class: 'campos' }, ...filhos));
}

export function lerForm(form) {
  const d = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') d[el.name] = el.checked;
    else if (el.type === 'number') d[el.name] = el.value === '' ? null : Number(el.value);
    else d[el.name] = el.value.trim() === '' ? undefined : el.value.trim();
  }
  return d;
}

// ------------------------------------------------------------------ formatação

export const fmt = (n, casas = 2) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: Math.min(casas, 2) });
export const qtd = (n) => fmt(n, 8);
export const inteiro = (n) => fmt(n, 0);
export const data = (s) => (s ? new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
export const pct = (x) => `${Math.round(Number(x) * 100)}%`;
export function relativo(s) {
  if (!s) return '—';
  const seg = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (seg < 60) return 'agora';
  if (seg < 3600) return `há ${Math.floor(seg / 60)} min`;
  if (seg < 86400) return `há ${Math.floor(seg / 3600)} h`;
  return `há ${Math.floor(seg / 86400)} d`;
}
export function precoCompacto(n) {
  if (n === null || n === undefined) return '—';
  const casas = n >= 1000 ? 2 : n >= 1 ? 4 : 8;
  return fmt(n, casas);
}

export const selo = (texto, classe = 'neutro', nomeIcone) => h('span', { class: `selo selo-${classe}` }, nomeIcone ? icone(nomeIcone) : h('i', { class: 'selo-ponto' }), texto);
export const seloSituacao = (sit) =>
  selo(sit, { executado: 'ok', executada: 'ok', ignorado: 'neutro', rejeitado: 'alerta', erro: 'perigo' }[sit] ?? 'neutro');
export const seloModo = (m) => (m === 'real' ? selo('real', 'perigo') : selo('simulação', 'alerta'));
export const seloLado = (l) => h('span', { class: `lado lado-${l}` }, icone(l === 'compra' ? 'compra' : 'venda'), l);

/** Avatar com iniciais e cor estável pelo texto. */
export function avatar(texto, classe = '') {
  let hash = 0;
  for (const c of texto) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const el = h('span', { class: `avatar ${classe}`, estilo: { '--matiz': String(hash % 360) } }, texto.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?');
  return el;
}

// ------------------------------------------------------------------ movimento

/** Conta de 0 até o valor (KPIs). */
export function contar(el, alvo, formatar = (v) => fmt(v)) {
  const fim = Number(alvo) || 0;
  if (reduzido() || fim === 0) {
    el.textContent = formatar(fim);
    return;
  }
  const inicio = performance.now();
  const duracao = 900;
  const passo = (agora) => {
    const k = Math.min(1, (agora - inicio) / duracao);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = formatar(fim * e);
    if (k < 1 && el.isConnected) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

/** Marca os filhos para entrarem um depois do outro. */
export function escalonar(lista, inicio = 0) {
  lista.forEach((el, i) => {
    if (!(el instanceof Element)) return;
    el.classList.add('entra');
    el.style.setProperty('--i', String(inicio + i));
  });
  return lista;
}

/** Botão "segure para confirmar": dispara só depois de segurar `ms`. */
export function botaoSegurar(rotulo, { classe = 'perigo', ms = 1200, aoConfirmar, nomeIcone = 'energia' }) {
  let inicio = 0;
  let raf = 0;
  const b = h('button', { class: `botao botao-segurar ${classe}`, type: 'button' }, h('span', { class: 'segurar-anel' }), icone(nomeIcone), h('span', {}, rotulo));
  const parar = () => {
    cancelAnimationFrame(raf);
    inicio = 0;
    b.style.setProperty('--p', '0');
    b.classList.remove('segurando');
  };
  const quadro = (agora) => {
    const k = Math.min(1, (agora - inicio) / ms);
    b.style.setProperty('--p', String(k));
    if (k >= 1) {
      parar();
      aoConfirmar();
    } else raf = requestAnimationFrame(quadro);
  };
  const comecar = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    inicio = performance.now();
    b.classList.add('segurando');
    raf = requestAnimationFrame(quadro);
  };
  b.addEventListener('pointerdown', comecar);
  b.addEventListener('pointerup', parar);
  b.addEventListener('pointerleave', parar);
  b.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && !inicio) {
      ev.preventDefault();
      comecar(ev);
    }
  });
  b.addEventListener('keyup', parar);
  b.title = 'Segure para confirmar';
  return b;
}

/** Copia texto e avisa. */
export function copiar(texto, aviso = 'Copiado') {
  navigator.clipboard.writeText(texto).then(() => avisar(aviso), () => avisar('Não deu para copiar', 'erro'));
}

/** Estado vazio ilustrado. */
export function vazio(titulo, texto, nomeIcone = 'painel', acao) {
  return h('div', { class: 'vazio' }, h('div', { class: 'vazio-icone' }, icone(nomeIcone)), h('strong', {}, titulo), texto ? h('p', { class: 'suave' }, texto) : null, acao ?? null);
}

/** Cabeçalho de página. */
export function cabecalho(titulo, subtitulo, ...acoes) {
  return h('div', { class: 'cabecalho' }, h('div', {}, h('h1', {}, titulo), subtitulo ? h('p', { class: 'suave' }, subtitulo) : null), acoes.length ? h('div', { class: 'acoes' }, ...acoes) : null);
}

export function botao(texto, { classe = '', nomeIcone, ...attrs } = {}) {
  return h('button', { class: `botao ${classe}`, type: 'button', ...attrs }, nomeIcone ? icone(nomeIcone) : null, texto ? h('span', {}, texto) : null);
}

export function botaoIcone(nomeIcone, titulo, { class: classe = '', ...attrs } = {}) {
  return h('button', { type: 'button', ...attrs, class: `botao-icone ${classe}`, title: titulo, 'aria-label': titulo }, icone(nomeIcone));
}
