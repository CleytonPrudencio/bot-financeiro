// Gráficos em SVG puro: área (volume por dia), rosca (sinais por situação), linha pequena
// (KPIs) e barra de uso de limite. As linhas usam pathLength=1 para a animação de "desenhar".

import { fmt, h, s } from './base.js';

function escala(min, max, de, ate) {
  const faixa = max - min || 1;
  return (v) => de + ((v - min) / faixa) * (ate - de);
}

function caminhoSuave(pontos) {
  if (!pontos.length) return '';
  let d = `M${pontos[0][0]},${pontos[0][1]}`;
  for (let i = 1; i < pontos.length; i++) {
    const [x0, y0] = pontos[i - 1];
    const [x1, y1] = pontos[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

/** Linha pequena para os cartões de KPI. */
export function linhaPequena(valores, cor = 'var(--primaria)') {
  const w = 120;
  const hh = 34;
  const max = Math.max(...valores, 1);
  const x = escala(0, Math.max(valores.length - 1, 1), 2, w - 2);
  const y = escala(0, max, hh - 3, 3);
  const pts = valores.map((v, i) => [x(i), y(v)]);
  const linha = caminhoSuave(pts);
  const id = `lp${Math.random().toString(36).slice(2, 8)}`;
  return s(
    'svg',
    { class: 'linha-pequena', viewBox: `0 0 ${w} ${hh}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    s('defs', {}, s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0', 'stop-color': cor, 'stop-opacity': 0.35 }), s('stop', { offset: '1', 'stop-color': cor, 'stop-opacity': 0 }))),
    pts.length > 1 ? s('path', { class: 'area-anima', d: `${linha} L${w - 2},${hh} L2,${hh} Z`, fill: `url(#${id})` }) : null,
    pts.length > 1 ? s('path', { class: 'traco-anima', d: linha, fill: 'none', stroke: cor, 'stroke-width': 1.8, pathLength: 1, 'vector-effect': 'non-scaling-stroke' }) : null,
  );
}

/**
 * Área com duas séries (compras e vendas por dia) e dica ao passar o mouse.
 * `dias` = [{dia: 'AAAA-MM-DD', compras, vendas, ordens}]
 */
export function graficoArea(dias) {
  const w = 640;
  const hh = 220;
  const m = { e: 44, d: 12, t: 14, b: 26 };
  const max = Math.max(1, ...dias.flatMap((d) => [d.compras, d.vendas]));
  const x = escala(0, Math.max(dias.length - 1, 1), m.e, w - m.d);
  const y = escala(0, max * 1.12, hh - m.b, m.t);
  const serie = (k) => dias.map((d, i) => [x(i), y(d[k])]);
  const compras = serie('compras');
  const vendas = serie('vendas');
  const base = hh - m.b;

  const grade = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = max * 1.12 * f;
    return s('g', {}, s('line', { x1: m.e, x2: w - m.d, y1: y(v), y2: y(v), class: 'grade-linha' }), s('text', { x: m.e - 8, y: y(v) + 4, class: 'grade-texto', 'text-anchor': 'end' }, compacto(v)));
  });
  const rotulos = dias.map((d, i) =>
    i % 2 === dias.length % 2 ? null : s('text', { x: x(i), y: hh - 6, class: 'grade-texto', 'text-anchor': 'middle' }, `${d.dia.slice(8, 10)}/${d.dia.slice(5, 7)}`),
  );

  const guia = s('line', { class: 'guia', y1: m.t, y2: base, x1: 0, x2: 0 });
  const pontoC = s('circle', { class: 'ponto ponto-compra', r: 4.5, cx: -10, cy: -10 });
  const pontoV = s('circle', { class: 'ponto ponto-venda', r: 4.5, cx: -10, cy: -10 });
  const dica = h('div', { class: 'dica-grafico', hidden: true });

  const svg = s(
    'svg',
    { class: 'grafico-area', viewBox: `0 0 ${w} ${hh}`, role: 'img', 'aria-label': 'Volume de compras e vendas por dia nos últimos 14 dias' },
    s(
      'defs',
      {},
      s('linearGradient', { id: 'g-compras', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0', 'stop-color': 'var(--primaria)', 'stop-opacity': 0.45 }), s('stop', { offset: '1', 'stop-color': 'var(--primaria)', 'stop-opacity': 0 })),
      s('linearGradient', { id: 'g-vendas', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0', 'stop-color': 'var(--ciano)', 'stop-opacity': 0.25 }), s('stop', { offset: '1', 'stop-color': 'var(--ciano)', 'stop-opacity': 0 })),
    ),
    grade,
    rotulos,
    s('path', { class: 'area-anima', d: `${caminhoSuave(compras)} L${x(dias.length - 1)},${base} L${m.e},${base} Z`, fill: 'url(#g-compras)' }),
    s('path', { class: 'area-anima', d: `${caminhoSuave(vendas)} L${x(dias.length - 1)},${base} L${m.e},${base} Z`, fill: 'url(#g-vendas)' }),
    s('path', { class: 'traco-anima', d: caminhoSuave(compras), fill: 'none', stroke: 'var(--primaria)', 'stroke-width': 2.4, pathLength: 1 }),
    s('path', { class: 'traco-anima atraso', d: caminhoSuave(vendas), fill: 'none', stroke: 'var(--ciano)', 'stroke-width': 2, pathLength: 1 }),
    guia,
    pontoC,
    pontoV,
  );

  const caixa = h('div', { class: 'grafico-caixa' }, svg, dica);
  svg.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * w;
    const i = Math.max(0, Math.min(dias.length - 1, Math.round(((px - m.e) / (w - m.e - m.d)) * (dias.length - 1))));
    const d = dias[i];
    if (!d) return;
    guia.setAttribute('x1', x(i));
    guia.setAttribute('x2', x(i));
    pontoC.setAttribute('cx', x(i));
    pontoC.setAttribute('cy', y(d.compras));
    pontoV.setAttribute('cx', x(i));
    pontoV.setAttribute('cy', y(d.vendas));
    caixa.classList.add('com-guia');
    dica.hidden = false;
    dica.replaceChildren(
      h('strong', {}, `${d.dia.slice(8, 10)}/${d.dia.slice(5, 7)}`),
      h('span', { class: 'dica-linha' }, h('i', { class: 'bolinha bolinha-compra' }), 'Compras ', h('b', {}, fmt(d.compras))),
      h('span', { class: 'dica-linha' }, h('i', { class: 'bolinha bolinha-venda' }), 'Vendas ', h('b', {}, fmt(d.vendas))),
      h('span', { class: 'dica-linha suave' }, `${d.ordens} ordem(ns)`),
    );
    const esquerda = (x(i) / w) * r.width;
    dica.style.setProperty('left', `${Math.min(r.width - 150, Math.max(0, esquerda - 70))}px`);
  });
  svg.addEventListener('pointerleave', () => {
    caixa.classList.remove('com-guia');
    dica.hidden = true;
  });
  return caixa;
}

function compacto(v) {
  if (v >= 1e6) return `${fmt(v / 1e6, 1)} mi`;
  if (v >= 1e3) return `${fmt(v / 1e3, 1)} mil`;
  return fmt(v, 0);
}

/** Rosca. `partes` = [{rotulo, valor, cor}] */
export function rosca(partes, centro, subcentro) {
  const total = partes.reduce((t, p) => t + p.valor, 0);
  const r = 52;
  const c = 2 * Math.PI * r;
  let acumulado = 0;
  const arcos = total
    ? partes.filter((p) => p.valor > 0).map((p, i) => {
        const fr = p.valor / total;
        const arco = s('circle', {
          class: 'rosca-arco',
          cx: 70, cy: 70, r,
          fill: 'none', stroke: p.cor, 'stroke-width': 16,
          'stroke-dasharray': `${Math.max(fr * c - 2, 0.1)} ${c}`,
          'stroke-dashoffset': -acumulado * c,
          transform: 'rotate(-90 70 70)',
          estilo: { '--i': String(i) },
        });
        acumulado += fr;
        return arco;
      })
    : [s('circle', { cx: 70, cy: 70, r, fill: 'none', stroke: 'var(--borda-forte)', 'stroke-width': 16 })];
  return h(
    'div',
    { class: 'rosca' },
    s('svg', { viewBox: '0 0 140 140', class: 'rosca-svg', role: 'img', 'aria-label': partes.map((p) => `${p.rotulo}: ${p.valor}`).join(', ') },
      s('circle', { cx: 70, cy: 70, r, fill: 'none', stroke: 'var(--trilho)', 'stroke-width': 16 }),
      arcos,
      s('text', { x: 70, y: 70, class: 'rosca-centro', 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, centro),
      s('text', { x: 70, y: 90, class: 'rosca-sub', 'text-anchor': 'middle' }, subcentro),
    ),
    h('ul', { class: 'legenda' }, partes.map((p) => h('li', {}, h('i', { class: 'bolinha', estilo: { background: p.cor } }), h('span', {}, p.rotulo), h('b', {}, String(p.valor))))),
  );
}

/** Barra de uso (ex.: gasto do dia sobre o limite). */
export function barraUso(usado, limite, rotulo, formatar = fmt) {
  const fr = limite > 0 ? Math.min(1, usado / limite) : 0;
  const nivel = fr >= 0.9 ? 'perigo' : fr >= 0.65 ? 'alerta' : 'ok';
  return h(
    'div',
    { class: 'uso' },
    h('div', { class: 'uso-topo' }, h('span', { class: 'suave' }, rotulo), h('span', { class: 'mono' }, `${formatar(usado)} / ${formatar(limite)}`)),
    h('div', { class: 'uso-trilho' }, h('div', { class: `uso-barra uso-${nivel}`, estilo: { '--fr': String(fr) } })),
  );
}

/**
 * Ganho e perda por dia: barra verde (ganho) ou vermelha (perda) e a linha do acumulado, com dica ao
 * passar o mouse. `dias` = [{dia: 'AAAA-MM-DD', resultado, operacoes, acumulado}]; `moeda` só no texto.
 */
export function graficoResultado(dias, moeda = '') {
  const w = 640;
  const hh = 230;
  const m = { e: 52, d: 52, t: 14, b: 26 };
  // duas escalas: as barras (resultado do dia, eixo da esquerda) e a linha do acumulado (eixo da
  // direita); com uma só, o acumulado achata as barras do dia
  const faixa = (valores) => {
    let min = Math.min(0, ...valores);
    let max = Math.max(0, ...valores);
    if (max - min < 1e-9) {
      max += 1;
      min -= 1;
    }
    const folga = (max - min) * 0.12;
    return [min - folga, max + folga];
  };
  const [bMin, bMax] = faixa(dias.map((d) => d.resultado));
  const [aMin, aMax] = faixa(dias.map((d) => d.acumulado));
  const y = escala(bMin, bMax, hh - m.b, m.t);
  const yA = escala(aMin, aMax, hh - m.b, m.t);
  const passo = (w - m.e - m.d) / Math.max(dias.length, 1);
  const cx = (i) => m.e + passo * (i + 0.5);
  const zero = y(0);
  const largura = Math.max(3, passo * 0.62);

  const grade = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = bMin + (bMax - bMin) * f;
    const vA = aMin + (aMax - aMin) * f;
    return s('g', {}, s('line', { x1: m.e, x2: w - m.d, y1: y(v), y2: y(v), class: 'grade-linha' }),
      s('text', { x: m.e - 8, y: y(v) + 4, class: 'grade-texto', 'text-anchor': 'end' }, fmt(v)),
      s('text', { x: w - m.d + 8, y: yA(vA) + 4, class: 'grade-texto grade-acumulado', 'text-anchor': 'start' }, fmt(vA)));
  });
  const rotulos = dias.map((d, i) => (i % 5 === (dias.length - 1) % 5 ? s('text', { x: cx(i), y: hh - 6, class: 'grade-texto', 'text-anchor': 'middle' }, `${d.dia.slice(8, 10)}/${d.dia.slice(5, 7)}`) : null));
  const barras = dias.map((d, i) => {
    if (!d.operacoes) return null;
    const topo = Math.min(y(d.resultado), zero);
    const altura = Math.max(1.5, Math.abs(y(d.resultado) - zero));
    return s('rect', { class: `barra-resultado ${d.resultado >= 0 ? 'ganho' : 'perda'}`, x: cx(i) - largura / 2, y: topo, width: largura, height: altura, rx: 3 });
  });
  const linha = caminhoSuave(dias.map((d, i) => [cx(i), yA(d.acumulado)]));
  const guia = s('line', { class: 'guia', y1: m.t, y2: hh - m.b, x1: -10, x2: -10 });
  const ponto = s('circle', { class: 'ponto ponto-acumulado', r: 4.5, cx: -10, cy: -10 });
  const dica = h('div', { class: 'dica-grafico', hidden: true });
  const svg = s('svg', { class: 'grafico-area grafico-resultado', viewBox: `0 0 ${w} ${hh}`, role: 'img', 'aria-label': `Ganho e perda por dia nos últimos ${dias.length} dias${moeda ? ` em ${moeda}` : ''}` },
    grade,
    s('line', { x1: m.e, x2: w - m.d, y1: zero, y2: zero, class: 'linha-zero' }),
    rotulos,
    barras,
    s('path', { class: 'traco-anima', d: linha, fill: 'none', stroke: 'var(--primaria)', 'stroke-width': 2.2, pathLength: 1 }),
    guia,
    ponto);
  const caixa = h('div', { class: 'grafico-caixa' }, svg, dica);
  svg.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * w;
    const i = Math.max(0, Math.min(dias.length - 1, Math.floor((px - m.e) / passo)));
    const d = dias[i];
    if (!d) return;
    guia.setAttribute('x1', cx(i));
    guia.setAttribute('x2', cx(i));
    ponto.setAttribute('cx', cx(i));
    ponto.setAttribute('cy', yA(d.acumulado));
    caixa.classList.add('com-guia');
    dica.hidden = false;
    const sinal = (v) => `${v > 0 ? '+' : ''}${fmt(v)}`;
    dica.replaceChildren(
      h('strong', {}, `${d.dia.slice(8, 10)}/${d.dia.slice(5, 7)}`),
      h('span', { class: `dica-linha ${d.resultado > 0 ? 'positivo' : d.resultado < 0 ? 'negativo' : ''}` }, `No dia: ${sinal(d.resultado)} ${moeda}`),
      h('span', { class: 'dica-linha' }, `Acumulado: ${sinal(d.acumulado)}`),
      h('span', { class: 'dica-linha suave' }, `${d.operacoes} operação(ões)`),
    );
    const esquerda = (cx(i) / w) * r.width;
    dica.style.setProperty('left', `${Math.min(r.width - 150, Math.max(0, esquerda - 70))}px`);
  });
  svg.addEventListener('pointerleave', () => {
    caixa.classList.remove('com-guia');
    dica.hidden = true;
  });
  return caixa;
}

/**
 * O saldo dia a dia contra o que foi colocado (linha tracejada): área verde acima, vermelha abaixo.
 * `serie` = [{dia, saldo}], `capital` = o valor colocado.
 */
export function graficoSaldo(serie, capital) {
  const w = 640;
  const hh = 150;
  const m = { e: 52, d: 12, t: 10, b: 22 };
  const valores = [...serie.map((p) => p.saldo), capital];
  let min = Math.min(...valores);
  let max = Math.max(...valores);
  if (max - min < 1e-9) {
    max += Math.max(1, capital * 0.02);
    min -= Math.max(1, capital * 0.02);
  }
  const folga = (max - min) * 0.15;
  const y = escala(min - folga, max + folga, hh - m.b, m.t);
  const x = escala(0, Math.max(serie.length - 1, 1), m.e, w - m.d);
  const pts = serie.map((p, i) => [x(i), y(p.saldo)]);
  // linha reta entre os dias: a curva suave inventava picos que o saldo não teve
  const linha = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join(' ');
  const ultimo = serie[serie.length - 1]?.saldo ?? capital;
  const cor = ultimo >= capital ? 'var(--ok)' : 'var(--perigo)';
  const id = `gs${Math.random().toString(36).slice(2, 8)}`;
  const base = y(capital);
  const grade = [min - folga, capital, max + folga].map((v) => s('text', { x: m.e - 8, y: y(v) + 4, class: 'grade-texto', 'text-anchor': 'end' }, fmt(v)));
  const rotulos = serie.map((p, i) => (i % 7 === (serie.length - 1) % 7 ? s('text', { x: x(i), y: hh - 5, class: 'grade-texto', 'text-anchor': 'middle' }, `${p.dia.slice(8, 10)}/${p.dia.slice(5, 7)}`) : null));
  return s('svg', { class: 'grafico-area grafico-saldo', viewBox: `0 0 ${w} ${hh}`, role: 'img', 'aria-label': `Saldo nos últimos ${serie.length} dias, contra o valor colocado de ${fmt(capital)}` },
    s('defs', {}, s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0', 'stop-color': cor, 'stop-opacity': 0.35 }), s('stop', { offset: '1', 'stop-color': cor, 'stop-opacity': 0 }))),
    grade,
    rotulos,
    s('line', { x1: m.e, x2: w - m.d, y1: base, y2: base, class: 'linha-zero' }),
    pts.length > 1 ? s('path', { class: 'area-anima', d: `${linha} L${x(serie.length - 1)},${base} L${m.e},${base} Z`, fill: `url(#${id})` }) : null,
    pts.length > 1 ? s('path', { class: 'traco-anima', d: linha, fill: 'none', stroke: cor, 'stroke-width': 2.4, pathLength: 1 }) : null,
    pts.length ? s('circle', { cx: pts[pts.length - 1][0], cy: pts[pts.length - 1][1], r: 4.5, fill: cor, class: 'ponto-saldo' }) : null);
}
