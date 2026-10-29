// Mesa de análise: 5 agentes de IA (técnico, fundamental, sentimento, risco e tese) dão nota a um
// ativo, no modelo do projeto ai-trading-claude (MIT). Pesquisa e educação: não executa nada.

import { api, cabecalho, data, escalonar, escolha, fmt, h, icone, interruptor, precoCompacto, relativo, s, selo, tentar, vazio } from '../base.js';

const CORES = { 'A+': 'var(--ok)', A: 'var(--ok)', B: 'var(--ciano)', C: 'var(--alerta)', D: '#fb923c', F: 'var(--perigo)' };
const corDaNota = (n) => (n >= 70 ? 'var(--ok)' : n >= 55 ? 'var(--ciano)' : n >= 40 ? 'var(--alerta)' : 'var(--perigo)');

function medidor(nota, conceito) {
  const arco = s('path', { d: 'M20 110 A90 90 0 0 1 200 110', class: 'medidor-valor', fill: 'none', stroke: CORES[conceito] ?? 'var(--primaria)', 'stroke-width': 16, 'stroke-linecap': 'round', pathLength: 100, 'stroke-dasharray': '100', 'stroke-dashoffset': '100' });
  const numero = s('text', { x: 110, y: 98, class: 'medidor-numero', 'text-anchor': 'middle' }, '0');
  requestAnimationFrame(() => requestAnimationFrame(() => arco.setAttribute('stroke-dashoffset', String(100 - nota))));
  const inicio = performance.now();
  const contar = (agora) => {
    const k = Math.min(1, (agora - inicio) / 1100);
    numero.textContent = String(Math.round(nota * (1 - Math.pow(1 - k, 3))));
    if (k < 1 && numero.isConnected) requestAnimationFrame(contar);
  };
  requestAnimationFrame(contar);
  return s('svg', { viewBox: '0 0 220 124', class: 'medidor', role: 'img', 'aria-label': `Nota ${nota} de 100` },
    s('path', { d: 'M20 110 A90 90 0 0 1 200 110', fill: 'none', stroke: 'var(--trilho)', 'stroke-width': 16, 'stroke-linecap': 'round' }),
    arco,
    numero,
    s('text', { x: 110, y: 118, class: 'medidor-sub', 'text-anchor': 'middle' }, 'de 100'));
}

function cartaoAgente(def, est) {
  const pronto = est?.situacao === 'pronto';
  const falhou = est?.situacao === 'falhou';
  const r = est?.resultado;
  return h('article', { class: `cartao agente ${pronto ? 'agente-pronto' : falhou ? 'agente-falhou' : 'agente-rodando'}` },
    h('div', { class: 'agente-topo' },
      h('div', {}, h('h3', {}, def.nome), h('span', { class: 'suave pequeno-texto' }, `peso ${Math.round(def.peso * 100)}% · ${est?.conector ?? ''}${est?.web ? ' · com pesquisa na web' : ''}`)),
      pronto ? h('div', { class: 'agente-nota', estilo: { color: corDaNota(r.nota) } }, String(r.nota), h('small', {}, '/100')) : falhou ? selo('falhou', 'perigo', 'alerta') : h('span', { class: 'pontinhos', estilo: { '--cor': 'var(--ia)' } }, h('i'), h('i'), h('i'))),
    pronto
      ? [
          h('div', { class: 'subnotas' }, r.subnotas.map((sn) =>
            h('div', { class: 'subnota' }, h('span', {}, sn.nome), h('div', { class: 'subnota-trilho' }, h('i', { estilo: { '--fr': String(sn.nota / 20), background: corDaNota(sn.nota * 5) } })), h('b', { class: 'mono' }, String(sn.nota))))),
          r.sinal ? h('div', { class: 'fichas' }, selo(r.sinal, 'ia')) : null,
          h('p', { class: 'agente-resumo' }, r.resumo),
          r.pontos.length ? h('ul', { class: 'agente-pontos' }, r.pontos.map((p) => h('li', {}, p))) : null,
          h('small', { class: 'suave' }, `${est.modelo} · ${(est.ms / 1000).toFixed(1)} s`),
        ]
      : falhou
        ? h('p', { class: 'perigo-txt' }, est.erro)
        : [h('div', { class: 'esqueleto esqueleto-texto' }), h('div', { class: 'esqueleto esqueleto-texto' }), h('div', { class: 'esqueleto esqueleto-texto curto' }), h('small', { class: 'suave' }, `${est?.modelo ?? ''} analisando…`)]);
}

function tabelaNiveis(a) {
  const linhas = ['tecnico', 'tese'].map((id) => [id, a.agentes?.[id]?.resultado?.niveis]).filter(([, n]) => n);
  if (!linhas.length) return null;
  const nome = { tecnico: 'Técnico', tese: 'Tese' };
  return h('div', { class: 'cartao' }, h('h2', {}, icone('cotacao'), 'Níveis de preço sugeridos'),
    h('div', { class: 'tabela-caixa' }, h('table', { class: 'tabela' },
      h('thead', {}, h('tr', {}, ['Agente', 'Entrada', 'Stop', 'Alvo 1', 'Alvo 2'].map((t) => h('th', {}, t)))),
      h('tbody', {}, linhas.map(([id, n]) => h('tr', {},
        h('td', {}, h('strong', {}, nome[id])),
        h('td', { class: 'mono' }, `${precoCompacto(n.entrada_min)} – ${precoCompacto(n.entrada_max)}`),
        h('td', { class: 'mono' }, h('span', { class: 'perigo-txt' }, precoCompacto(n.stop))),
        h('td', { class: 'mono' }, h('span', { class: 'ok-txt' }, precoCompacto(n.alvo1))),
        h('td', { class: 'mono' }, h('span', { class: 'ok-txt' }, precoCompacto(n.alvo2)))))))));
}

function painelDados(d) {
  if (!d) return null;
  if (d.erro) return h('div', { class: 'destaque destaque-alerta' }, icone('alerta'), h('p', {}, `Sem dados de mercado: ${d.erro}. Os agentes trabalharam só com o que sabem (e com a web, se ligada).`));
  const itens = [
    ['Preço', precoCompacto(d.preco)],
    ['30 dias', d.retorno_30d_pct === null ? '—' : `${fmt(d.retorno_30d_pct)}%`],
    ['90 dias', d.retorno_90d_pct === null ? '—' : `${fmt(d.retorno_90d_pct)}%`],
    ['IFR 14', fmt(d.ifr_14, 1)],
    ['Média 50', precoCompacto(d.media_50d)],
    ['Média 200', precoCompacto(d.media_200d)],
    ['MACD (hist.)', fmt(d.macd?.histograma, 2)],
    ['Bollinger', d.bollinger_20 ? `${Math.round(d.bollinger_20.posicao * 100)}% da banda` : '—'],
    ['ATR 14', d.atr_14_pct === null ? '—' : `${fmt(d.atr_14_pct)}%`],
    ['Vol. 30d (ano)', d.volatilidade_30d_anual_pct === null ? '—' : `${fmt(d.volatilidade_30d_anual_pct, 1)}%`],
    ['Queda desde o topo', `${fmt(d.queda_desde_topo_pct, 1)}%`],
    ['Força vs BTC 30d', d.forca_relativa_vs_btc_30d_pct === null ? '—' : `${fmt(d.forca_relativa_vs_btc_30d_pct)} p.p.`],
  ];
  return [previsaoKronos(d), h('div', { class: 'cartao' }, h('div', { class: 'cartao-topo' }, h('div', {}, h('h2', {}, icone('painel'), 'Dados que os agentes receberam'), h('p', { class: 'suave' }, `${d.dias_de_historico} velas diárias da ${d.exchange}, calculados aqui (não pela IA)`))),
    h('div', { class: 'dados-grade' }, itens.map(([r, v]) => h('div', {}, h('span', { class: 'suave' }, r), h('strong', { class: 'mono' }, v)))))];
}

/** Leque da previsão do Kronos: últimas velas, mediana dos caminhos e a faixa de 10% a 90%. */
function previsaoKronos(d) {
  const k = d.previsao_kronos;
  if (!k) return null;
  if (k.erro) return h('div', { class: 'destaque' }, icone('cotacao'), h('p', {}, `Previsão do Kronos indisponível: ${k.erro}.`));
  const w = 600;
  const hh = 180;
  const hist = (d.ultimas_5_velas ?? []).map((v) => v.fecha);
  const todos = [...hist, ...k.p10, ...k.p90];
  const min = Math.min(...todos);
  const max = Math.max(...todos);
  const n = hist.length + k.mediana.length;
  const x = (i) => 20 + (i / Math.max(n - 1, 1)) * (w - 40);
  const y = (v) => hh - 18 - ((v - min) / (max - min || 1)) * (hh - 36);
  const base = hist.length - 1;
  const ponto = (i, v) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  const hoje = hist[hist.length - 1] ?? k.mediana[0];
  const faixa = [ponto(base, hoje), ...k.p90.map((v, i) => ponto(base + 1 + i, v)), ...k.p10.map((v, i) => ponto(base + 1 + i, v)).reverse()].join(' ');
  const mediana = [ponto(base, hoje), ...k.mediana.map((v, i) => ponto(base + 1 + i, v))].join(' ');
  const fmt = (v) => `${v >= 0 ? '+' : ''}${fmt2(v)}%`;
  const fmt2 = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const chance = Math.round(k.chance_de_terminar_acima * 100);
  return h('div', { class: 'cartao leque' },
    h('div', { class: 'cartao-topo' }, h('div', {}, h('h2', {}, icone('cotacao'), `Previsão do Kronos · próximos ${k.horizonte_dias} dias`), h('p', { class: 'suave' }, `${k.caminhos_simulados} caminhos simulados pelo modelo ${String(k.modelo).split('/').pop()} · ${k.observacao}`)),
      selo(`${chance}% de chance de alta`, chance >= 60 ? 'ok' : chance <= 40 ? 'perigo' : 'neutro')),
    s('svg', { viewBox: `0 0 ${w} ${hh}`, role: 'img', 'aria-label': `Mediana ${fmt(k.retorno_mediano_pct)}, faixa de ${fmt(k.faixa_10_a_90_pct[0])} a ${fmt(k.faixa_10_a_90_pct[1])}` },
      s('line', { class: 'leque-hoje', x1: x(base), x2: x(base), y1: 8, y2: hh - 10 }),
      s('polygon', { class: 'leque-faixa area-anima', points: faixa }),
      hist.length > 1 ? s('polyline', { class: 'leque-historico', points: hist.map((v, i) => ponto(i, v)).join(' ') }) : null,
      s('polyline', { class: 'leque-mediana traco-anima', points: mediana, pathLength: 1 })),
    h('div', { class: 'dados-grade' },
      h('div', {}, h('span', { class: 'suave' }, 'Mediana'), h('strong', { class: 'mono' }, fmt(k.retorno_mediano_pct))),
      h('div', {}, h('span', { class: 'suave' }, 'Faixa 10%–90%'), h('strong', { class: 'mono' }, `${fmt(k.faixa_10_a_90_pct[0])} a ${fmt(k.faixa_10_a_90_pct[1])}`)),
      h('div', {}, h('span', { class: 'suave' }, 'Chance de alta'), h('strong', { class: 'mono' }, `${chance}%`))));
}

function resultado(a, agentes) {
  const pronta = a.situacao === 'pronta';
  const prontos = agentes.filter((d) => a.agentes?.[d.id]?.situacao === 'pronto').length;
  return [
    h('div', { class: 'cartao resultado-topo' },
      pronta ? medidor(a.nota, a.conceito) : h('div', { class: 'medidor-carregando' }, h('span', { class: 'anel-girando' }), h('strong', {}, a.situacao === 'falhou' ? 'Falhou' : `${prontos}/5`)),
      h('div', { class: 'resultado-texto' },
        h('span', { class: 'suave' }, `Análise #${a.id} · ${data(a.criada_em)}${a.pesquisa_web ? ' · com pesquisa na web' : ''}`),
        h('h2', { class: 'resultado-par' }, a.simbolo),
        pronta
          ? h('div', { class: 'fichas' }, h('span', { class: 'conceito', estilo: { '--cor': CORES[a.conceito] } }, a.conceito), h('strong', { class: 'resultado-sinal', estilo: { color: CORES[a.conceito] } }, a.sinal))
          : a.situacao === 'falhou' ? h('p', { class: 'perigo-txt' }, 'Nenhum agente respondeu. Veja o erro de cada um abaixo.') : h('p', { class: 'suave' }, 'Os 5 agentes estão trabalhando ao mesmo tempo…'),
        h('p', { class: 'suave pequeno-texto' }, 'Nota = técnico 25% + fundamental 25% + sentimento 20% + risco 15% + tese 15%. Pesquisa e educação, não é recomendação de investimento.'))),
    h('div', { class: 'grade-agentes' }, agentes.map((d) => cartaoAgente(d, a.agentes?.[d.id]))),
    pronta ? tabelaNiveis(a) : null,
    ...[].concat(painelDados(a.dados) ?? []),
  ];
}

export async function paginaAnalises({ aoSair }) {
  const [ias, historico, estrategias, contas, agentes] = await Promise.all([
    api('GET', '/ias'), api('GET', '/analises'), api('GET', '/estrategias'), api('GET', '/contas'), api('GET', '/analises/agentes'),
  ]);
  const ativos = ias.filter((c) => c.ativo);
  const area = h('div', { class: 'area-resultado' });
  const lista = h('div');
  let atual = null;
  let vigia = null;

  const desenharHistorico = (itens) =>
    lista.replaceChildren(itens.length
      ? h('div', { class: 'cartao' }, h('h2', {}, icone('relogio'), 'Análises anteriores'), h('ol', { class: 'historico' }, itens.map((x) =>
          h('li', { class: `historico-item ${atual === x.id ? 'escolhido' : ''}`, onclick: () => abrir(x.id) },
            x.nota !== null ? h('span', { class: 'historico-nota', estilo: { '--cor': CORES[x.conceito] } }, String(x.nota)) : h('span', { class: 'historico-nota vazia' }, x.situacao === 'rodando' ? '…' : '×'),
            h('div', {}, h('strong', {}, x.simbolo), h('span', { class: 'suave pequeno-texto' }, `${x.sinal ?? x.situacao} · ${relativo(x.criada_em)}`)),
            icone('seta')))))
      : null);

  async function abrir(id) {
    atual = id;
    const a = await tentar(() => api('GET', `/analises/${id}`));
    if (!a) return;
    area.replaceChildren(...escalonar(resultado(a, agentes).filter(Boolean)));
    desenharHistorico(await api('GET', '/analises'));
    clearInterval(vigia);
    if (a.situacao === 'rodando') {
      let ultimo = JSON.stringify(a.agentes);
      vigia = setInterval(async () => {
        const n = await api('GET', `/analises/${id}`).catch(() => null);
        if (!n || atual !== id) return;
        if (JSON.stringify(n.agentes) !== ultimo || n.situacao !== 'rodando') {
          ultimo = JSON.stringify(n.agentes);
          area.replaceChildren(...resultado(n, agentes).filter(Boolean));
        }
        if (n.situacao !== 'rodando') {
          clearInterval(vigia);
          desenharHistorico(await api('GET', '/analises'));
        }
      }, 1500);
    }
  }
  aoSair(() => clearInterval(vigia));

  const simbolos = [...new Set(estrategias.map((e) => e.simbolo))];
  const exchanges = [...new Set(['binance', ...contas.map((c) => c.exchange)])];
  const escolhidos = new Set(ativos.map((c) => c.id));
  const form = h('form', {
    class: 'form',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const r = await tentar(() => api('POST', '/analises', {
        simbolo: String(fd.get('simbolo') ?? '').trim(),
        exchange: String(fd.get('exchange') ?? '') || null,
        conectores: [...escolhidos],
        pesquisa_web: form.querySelector('[name=pesquisa_web]').checked,
      }), 'Análise iniciada: os 5 agentes estão trabalhando');
      if (r) abrir(r.id);
    },
  },
    h('div', { class: 'campos' },
      h('label', { class: 'campo' }, h('span', { class: 'campo-rotulo' }, 'Ativo'), h('input', {
        name: 'simbolo', required: true, list: 'lista-simbolos', placeholder: 'BTC/USDT', value: simbolos[0] ?? 'BTC/USDT',
        // par de uma estratégia: usa as velas da exchange da conta dela
        oninput: (ev) => {
          const e = estrategias.find((x) => x.simbolo === ev.target.value.trim().toUpperCase());
          if (e) form.querySelector('[name=exchange]').value = e.exchange;
        },
      }), h('small', { class: 'campo-dica' }, 'par da exchange (BTC/USDT) ou ticker (PETR4, AAPL): sem barra, vai sem velas')),
      h('datalist', { id: 'lista-simbolos' }, simbolos.map((x) => h('option', { value: x }))),
      escolha('Exchange das velas', 'exchange', exchanges.map((e) => [e, e]), estrategias.find((e) => e.simbolo === simbolos[0])?.exchange ?? exchanges[0]),
    ),
    h('div', { class: 'campo campo-largo' }, h('span', { class: 'campo-rotulo' }, 'IAs que fazem a análise (os 5 agentes se dividem entre elas)'),
      h('div', { class: 'fichas' }, ativos.map((c) => h('button', {
        type: 'button', class: 'chip escolhido', estilo: { '--cor': 'var(--ia)' },
        onclick: (ev) => {
          if (escolhidos.has(c.id)) escolhidos.delete(c.id);
          else escolhidos.add(c.id);
          ev.currentTarget.classList.toggle('escolhido', escolhidos.has(c.id));
        },
      }, icone('ias'), c.nome)))),
    interruptor('Pesquisar na web', { name: 'pesquisa_web' }, 'só nos conectores Claude; busca notícias e dados da empresa/projeto (custo extra por busca)'),
    h('div', { class: 'acoes acoes-fim' }, h('button', { class: 'botao botao-ia', type: 'submit' }, icone('ias'), h('span', {}, 'Analisar com 5 agentes'))),
  );

  desenharHistorico(historico);
  if (historico[0]) abrir(historico[0].id);

  return [
    cabecalho('Mesa de análise', 'Cinco agentes de IA dão nota a um ativo: técnico, fundamental, sentimento, risco e tese. A nota pode travar compras numa estratégia.'),
    ativos.length
      ? h('div', { class: 'grade-analise' },
          h('div', { class: 'coluna-analise' }, h('div', { class: 'cartao' }, h('h2', {}, icone('estrategias'), 'Nova análise'), form), lista),
          area)
      : vazio('Conecte uma IA primeiro', 'Os agentes rodam nas IAs que você conectar (Claude, ChatGPT, Gemini, Ollama…).', 'ias', h('a', { class: 'botao', href: '#/ias' }, 'Ir para IAs')),
    h('p', { class: 'rodape-pagina suave' }, icone('escudo'), 'Agentes adaptados do projeto ai-trading-claude (licença MIT). Pesquisa e educação, não é recomendação de investimento.'),
  ];
}
