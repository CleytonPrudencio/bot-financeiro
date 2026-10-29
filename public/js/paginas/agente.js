// Agente em etapas: uma esteira de IAs. Pesquisa, sentimento, técnica e risco rodam ao mesmo tempo,
// cada uma na IA escolhida; a decisão final lê os relatórios e aprova ou veta (só pode barrar).

import { api, botao, cabecalho, data, escalonar, escolha, h, icone, pct, relativo, selo, tentar, vazio } from '../base.js';

const VIES = { a_favor: ['a favor', 'ok'], contra: ['contra', 'perigo'], neutro: ['neutro', 'neutro'] };

function cartaoResultado(etapa, saida) {
  const decisao = etapa.id === 'decisao';
  if (!saida) return h('div', { class: 'etapa-saida suave' }, 'desligada');
  if (saida.situacao === 'rodando') {
    return h('div', { class: 'etapa-saida' }, h('span', { class: 'pontinhos', estilo: { '--cor': 'var(--ia)' } }, h('i'), h('i'), h('i')), h('div', { class: 'esqueleto esqueleto-texto' }), h('div', { class: 'esqueleto esqueleto-texto curto' }));
  }
  if (saida.situacao === 'falhou' || saida.ok === false) return h('div', { class: 'etapa-saida' }, selo('falhou', 'perigo', 'alerta'), h('p', { class: 'perigo-txt pequeno-texto' }, saida.erro));
  if (decisao) {
    const p = saida.parecer;
    return h('div', { class: `etapa-saida veredito veredito-${p.decisao}` },
      h('strong', { class: 'veredito-titulo' }, icone(p.decisao === 'aprovar' ? 'ok' : 'fechar'), p.decisao === 'aprovar' ? 'APROVARIA' : 'VETARIA'),
      h('span', { class: 'mono suave' }, `confiança ${pct(p.confianca)} · ${(saida.ms / 1000).toFixed(1)} s`),
      h('p', {}, p.motivo));
  }
  const r = saida.resultado;
  const [texto, classe] = VIES[r.vies] ?? VIES.neutro;
  return h('div', { class: 'etapa-saida' },
    h('div', { class: 'etapa-saida-topo' }, selo(texto, classe), h('span', { class: 'mono suave' }, `${r.nota}/100 · ${(saida.ms / 1000).toFixed(1)} s${saida.web ? ' · web' : ''}`)),
    h('div', { class: 'uso-trilho' }, h('div', { class: `uso-barra uso-${r.nota >= 60 ? 'ok' : r.nota >= 40 ? 'alerta' : 'perigo'}`, estilo: { '--fr': String(r.nota / 100) } })),
    h('p', { class: 'pequeno-texto' }, r.resumo),
    r.pontos.length ? h('ul', { class: 'agente-pontos' }, r.pontos.map((x) => h('li', {}, x))) : null);
}

/** A esteira desenhada: quatro etapas lado a lado, setas e a decisão no fim. */
function esteira(etapas, conteudo) {
  const apoio = etapas.filter((e) => e.id !== 'decisao');
  const final = etapas.find((e) => e.id === 'decisao');
  return h('div', { class: 'esteira' },
    h('div', { class: 'esteira-etapas' }, escalonar(apoio.map((e, i) => h('div', { class: 'cartao etapa' }, h('div', { class: 'etapa-topo' }, h('span', { class: 'etapa-numero' }, String(i + 1)), h('h3', {}, e.nome)), conteudo(e))))),
    h('div', { class: 'esteira-seta', 'aria-hidden': 'true' }, h('span'), icone('venda')),
    h('div', { class: 'cartao etapa etapa-decisao' }, h('div', { class: 'etapa-topo' }, h('span', { class: 'etapa-numero' }, String(apoio.length + 1)), h('h3', {}, final.nome)), conteudo(final)));
}

export async function paginaAgente({ recarregar, aoSair }) {
  const [info, ias, historico, contas] = await Promise.all([api('GET', '/agente'), api('GET', '/ias'), api('GET', '/agente/execucoes'), api('GET', '/contas')]);
  const ativos = ias.filter((c) => c.ativo);
  if (!ias.length) {
    return [
      cabecalho('Agente em etapas', 'Uma esteira de IAs: cada etapa com a IA que é melhor naquilo, e uma decisão no fim.'),
      vazio('Conecte as IAs primeiro', 'Cadastre pelo menos uma IA (o ideal é uma para cada etapa: Perplexity, Grok, Qwen, DeepSeek, Claude Opus).', 'ias', h('a', { class: 'botao', href: '#/ias' }, 'Ir para IAs')),
    ];
  }
  const config = structuredClone(info.config);
  const selects = new Map();
  const webs = new Map();
  let kronosLigado = null;

  const configuracao = esteira(info.etapas, (e) => {
    if (e.kronos) {
      const k = info.kronos;
      const caixa = h('input', { type: 'checkbox', checked: Boolean(config.etapas.previsao?.ligada) });
      kronosLigado = caixa;
      return [
        h('p', { class: 'suave pequeno-texto etapa-papel' }, e.papel.split(':')[1]?.trim() ?? e.papel),
        h('p', { class: 'etapa-recomendado' }, icone('cotacao'), h('span', {}, h('strong', {}, e.recomendado))),
        k.ok ? selo(`no ar · ${k.modelo?.split('/').pop() ?? 'Kronos'}`, 'ok') : selo(k.erro ?? 'fora do ar', 'alerta', 'alerta'),
        h('label', { class: 'interruptor etapa-web' }, caixa, h('span', { class: 'interruptor-trilho' }, h('span', { class: 'interruptor-bola' })), h('span', { class: 'interruptor-texto' }, h('span', {}, 'Usar a previsão'), h('small', { class: 'campo-dica' }, 'roda na VM, sem custo; nada sai para a internet'))),
      ];
    }
    const atual = config.etapas[e.id]?.conector_id ?? '';
    const sel = h('select', { 'aria-label': `IA da etapa ${e.nome}` },
      e.id === 'decisao' ? h('option', { value: '' }, 'escolha uma IA…') : h('option', { value: '' }, '— desligada —'),
      ias.map((c) => h('option', { value: c.id, selected: String(c.id) === String(atual), disabled: !c.ativo }, `${c.nome} · ${c.modelo}${c.ativo ? '' : ' (desativada)'}`)));
    selects.set(e.id, sel);
    const web = e.usa_web ? h('label', { class: 'interruptor etapa-web' }, h('input', { type: 'checkbox', checked: Boolean(config.etapas[e.id]?.web) }), h('span', { class: 'interruptor-trilho' }, h('span', { class: 'interruptor-bola' })), h('span', { class: 'interruptor-texto' }, h('span', {}, 'Pesquisar na web'), h('small', { class: 'campo-dica' }, 'só no Claude; o Perplexity já pesquisa sozinho'))) : null;
    if (web) webs.set(e.id, web.querySelector('input'));
    return [
      h('p', { class: 'suave pequeno-texto etapa-papel' }, e.papel.split(':')[1]?.trim() ?? e.papel),
      h('p', { class: 'etapa-recomendado' }, icone('ias'), h('span', {}, 'Melhor para isso: ', h('strong', {}, e.recomendado))),
      sel,
      web,
    ];
  });

  const ler = () => ({
    etapas: Object.fromEntries(info.etapas.map((e) =>
      e.kronos
        ? [e.id, { ligada: Boolean(kronosLigado?.checked) }]
        : [e.id, { conector_id: selects.get(e.id).value ? Number(selects.get(e.id).value) : null, ...(webs.has(e.id) ? { web: webs.get(e.id).checked } : {}) }])),
  });

  const salvar = async () => {
    if (await tentar(() => api('PUT', '/agente', ler()), 'Agente salvo')) recarregar({ suave: true });
  };
  const montar = () => {
    for (const [id, sel] of selects) sel.value = info.sugestao[id] ?? '';
    if (kronosLigado && info.kronos.ok) kronosLigado.checked = true;
    for (const sel of selects.values()) {
      sel.classList.add('piscou');
      setTimeout(() => sel.classList.remove('piscou'), 900);
    }
  };

  // ---------------------------------------------------------------- teste ao vivo
  const area = h('div', { class: 'area-resultado' });
  let vigia = null;
  aoSair(() => clearInterval(vigia));

  function desenharExecucao(x) {
    const final = x.etapas?.decisao;
    area.replaceChildren(
      h('div', { class: 'cartao resultado-agente' },
        h('div', { class: 'cartao-topo' },
          h('div', {}, h('h2', {}, icone('robo'), `${x.lado === 'compra' ? 'Compra' : 'Venda'} de ${x.simbolo}`), h('p', { class: 'suave' }, `${x.origem === 'sinal' ? 'sinal de verdade' : 'teste do painel'} · ${data(x.criada_em)}${x.ms ? ` · ${(x.ms / 1000).toFixed(1)} s no total` : ''}`)),
          x.situacao === 'rodando' ? selo('rodando', 'ia') : x.decisao ? selo(x.decisao === 'aprovar' ? 'aprovaria' : 'vetaria', x.decisao === 'aprovar' ? 'ok' : 'perigo') : selo('falhou', 'perigo')),
        esteira(info.etapas, (e) => cartaoResultado(e, e.id === 'decisao' && !final && x.situacao !== 'rodando' && x.motivo ? { situacao: 'falhou', erro: x.motivo } : x.etapas?.[e.id] ?? (e.id === 'decisao' && x.situacao === 'rodando' ? { situacao: 'rodando' } : null))),
      ));
  }

  async function abrir(id) {
    clearInterval(vigia);
    const x = await tentar(() => api('GET', `/agente/execucoes/${id}`));
    if (!x) return;
    desenharExecucao(x);
    if (x.situacao === 'rodando') {
      let ultimo = JSON.stringify(x);
      vigia = setInterval(async () => {
        const n = await api('GET', `/agente/execucoes/${id}`).catch(() => null);
        if (!n) return;
        if (JSON.stringify(n) !== ultimo) {
          ultimo = JSON.stringify(n);
          desenharExecucao(n);
        }
        if (n.situacao !== 'rodando') {
          clearInterval(vigia);
          lista.replaceChildren(...itensHistorico(await api('GET', '/agente/execucoes')));
        }
      }, 1500);
    }
  }

  const exchanges = [...new Set(['binance', ...contas.map((c) => c.exchange)])];
  const formTeste = h('form', {
    class: 'form-linha',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const fd = new FormData(formTeste);
      const r = await tentar(() => api('POST', '/agente/testar', { simbolo: String(fd.get('simbolo')), lado: String(fd.get('lado')), valor: Number(fd.get('valor')) || 100, exchange: String(fd.get('exchange')) || null }), 'Agente rodando: cada etapa aparece quando terminar');
      if (r) abrir(r.id);
    },
  },
    h('label', { class: 'campo' }, h('span', { class: 'campo-rotulo' }, 'Ativo'), h('input', { name: 'simbolo', required: true, value: 'BTC/USDT' })),
    escolha('Lado', 'lado', [['compra', 'Compra'], ['venda', 'Venda']], 'compra'),
    h('label', { class: 'campo' }, h('span', { class: 'campo-rotulo' }, 'Valor'), h('input', { name: 'valor', type: 'number', min: '1', step: 'any', value: '100' })),
    escolha('Exchange', 'exchange', exchanges.map((e) => [e, e]), exchanges[0]),
    h('button', { class: 'botao botao-ia', type: 'submit', disabled: !info.pronto }, icone('testar'), h('span', {}, 'Testar o agente')),
  );

  const itensHistorico = (itens) => itens.map((x) =>
    h('li', { class: 'historico-item', onclick: () => abrir(x.id) },
      h('span', { class: `historico-nota ${x.decisao ? '' : 'vazia'}`, estilo: { '--cor': x.decisao === 'aprovar' ? 'var(--ok)' : 'var(--perigo)' } }, x.decisao === 'aprovar' ? '✔' : x.decisao === 'vetar' ? '✖' : x.situacao === 'rodando' ? '…' : '×'),
      h('div', {}, h('strong', {}, `${x.lado} ${x.simbolo}`), h('span', { class: 'suave pequeno-texto' }, `${x.origem === 'sinal' ? x.estrategia ?? 'sinal' : 'teste'} · ${relativo(x.criada_em)}${x.confianca !== null ? ` · ${pct(x.confianca)}` : ''}`)),
      icone('seta')));
  const lista = h('ol', { class: 'historico' }, itensHistorico(historico));
  if (historico[0]) abrir(historico[0].id);

  return [
    cabecalho('Agente em etapas', 'Uma esteira de IAs: cada etapa com a IA que é melhor naquilo; no fim, uma IA lê tudo e decide. Como o conselho, só pode barrar a ordem.',
      botao('Montar automático', { classe: 'secundario', nomeIcone: 'ias', onclick: montar, title: 'Escolhe para cada etapa a IA cadastrada que mais combina com ela' }),
      botao('Salvar', { nomeIcone: 'ok', onclick: salvar })),
    info.pronto
      ? h('div', { class: 'destaque destaque-ia' }, icone('robo'), h('div', {}, h('strong', {}, 'Agente pronto'), h('p', {}, 'Para usar numa estratégia: edite a estratégia, em "Parecer das IAs" escolha o modo obrigatório ou consultivo e, em "Como as IAs decidem", Agente em etapas.')))
      : h('div', { class: 'destaque destaque-alerta' }, icone('alerta'), h('div', {}, h('strong', {}, 'Falta a IA da decisão final'), h('p', {}, `Escolha a IA da etapa 5 e salve (ou use "Montar automático"). ${ativos.length < 3 ? 'Dica: quanto mais IAs diferentes, melhor — cada uma erra de um jeito.' : ''}`))),
    configuracao,
    h('div', { class: 'grade-analise' },
      h('div', { class: 'coluna-analise' },
        h('div', { class: 'cartao' }, h('h2', {}, icone('testar'), 'Testar com uma ordem de mentira'), h('p', { class: 'suave pequeno-texto' }, 'Nenhuma ordem sai. Usa as IAs de verdade (gasta créditos).'), formTeste),
        historico.length ? h('div', { class: 'cartao' }, h('h2', {}, icone('relogio'), 'Passadas anteriores'), lista) : null),
      area),
    h('p', { class: 'rodape-pagina suave' }, icone('escudo'), 'Pesquisa, sentimento, previsão, técnica e risco rodam ao mesmo tempo; a decisão vem depois. Montar automático só sugere: confira e salve.'),
  ];
}
