// Painel do Bot Financeiro. Sem framework e sem build: o DOM é montado com h(), que só usa
// textContent, então nada que venha do banco ou de um sinal vira HTML.

const $ = (s) => document.querySelector(s);
const conteudo = $('#conteudo');

function h(tag, attrs = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const f of filhos.flat()) {
    if (f === undefined || f === null || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return el;
}

// ------------------------------------------------------------------ API

async function api(metodo, caminho, corpo) {
  const r = await fetch('/api' + caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json', 'x-painel': '1' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const dados = await r.json().catch(() => ({}));
  if (r.status === 401 && caminho !== '/login') {
    mostrarLogin();
    throw new Error('sessão expirou');
  }
  if (!r.ok) throw new Error(dados.erro ?? `erro ${r.status}`);
  return dados;
}

let avisoTimer;
function avisar(texto, erro = false) {
  const el = $('#aviso');
  el.textContent = texto;
  el.className = erro ? 'erro' : '';
  el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => (el.hidden = true), erro ? 7000 : 3500);
}

/** Roda uma ação e mostra o erro, se houver. */
async function tentar(fn, sucesso) {
  try {
    const r = await fn();
    if (sucesso) avisar(sucesso);
    return r;
  } catch (e) {
    avisar(e.message, true);
    return undefined;
  }
}

// ------------------------------------------------------------------ formatação

const fmt = (n, casas = 2) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: Math.min(casas, 2) });
const qtd = (n) => fmt(n, 8);
const data = (s) => (s ? new Date(s).toLocaleString('pt-BR') : '—');
const selo = (texto, classe) => h('span', { class: `selo ${classe}` }, texto);
const seloSituacao = (s) =>
  selo(s, { executado: 'ok', executada: 'ok', ignorado: 'suave', rejeitado: 'alerta-txt', erro: 'perigo-txt' }[s] ?? 'suave');
const seloModo = (m) => (m === 'real' ? selo('real', 'perigo-txt') : selo('simulação', 'alerta-txt'));

function tabela(colunas, linhas, vazio = 'Nada por aqui ainda.') {
  if (!linhas.length) return h('p', { class: 'suave' }, vazio);
  return h(
    'div',
    { class: 'rolagem' },
    h('table', {}, h('thead', {}, h('tr', {}, colunas.map((c) => h('th', {}, c[0])))), h('tbody', {}, linhas.map((l) => h('tr', {}, colunas.map((c) => h('td', {}, c[1](l))))))),
  );
}

function campo(rotulo, attrs) {
  return h('label', {}, rotulo, h('input', attrs));
}
function caixa(rotulo, attrs) {
  return h('label', { class: 'marcar' }, h('input', { type: 'checkbox', ...attrs }), rotulo);
}
function lerForm(form) {
  const d = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') d[el.name] = el.checked;
    else if (el.type === 'number') d[el.name] = el.value === '' ? null : Number(el.value);
    else d[el.name] = el.value.trim() === '' ? undefined : el.value.trim();
  }
  return d;
}

function janela(titulo, ...corpo) {
  const d = h('dialog', {}, h('h2', {}, titulo), ...corpo, h('div', { class: 'acoes' }, h('button', { class: 'secundario', onclick: () => d.close() }, 'Fechar')));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

// ------------------------------------------------------------------ login e moldura

function mostrarLogin() {
  $('#topo').hidden = true;
  $('#faixa').hidden = true;
  const form = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        const r = await tentar(() => api('POST', '/login', d));
        if (r) iniciar();
      },
    },
    campo('E-mail', { name: 'email', type: 'email', autocomplete: 'username', required: true }),
    campo('Senha', { name: 'senha', type: 'password', autocomplete: 'current-password', required: true }),
    h('button', { type: 'submit' }, 'Entrar'),
  );
  conteudo.replaceChildren(h('div', { class: 'cartao login' }, h('h1', {}, 'Bot Financeiro'), form));
}

$('#sair').addEventListener('click', async () => {
  await tentar(() => api('POST', '/logout'));
  mostrarLogin();
});

async function faixa() {
  const r = await api('GET', '/resumo');
  const el = $('#faixa');
  if (r.parada_geral) {
    el.textContent = 'PARADA GERAL LIGADA: nenhuma ordem sai';
    el.className = '';
    el.hidden = false;
  } else if (!r.real_no_servidor) {
    el.textContent = 'Dinheiro real desligado no servidor: tudo roda em simulação';
    el.className = 'simulacao';
    el.hidden = false;
  } else {
    el.hidden = true;
  }
  return r;
}

// ------------------------------------------------------------------ páginas

async function paginaPainel() {
  const r = await faixa();
  const ligada = r.parada_geral;
  return [
    h('h1', {}, 'Painel'),
    h(
      'div',
      { class: 'cartao parada' },
      h('div', {}, h('strong', {}, ligada ? 'Parada geral LIGADA' : 'Robô operando'), h('div', { class: 'rotulo' }, ligada ? 'Nenhum sinal vira ordem até desligar.' : 'Ligue para bloquear todas as ordens na hora, de todas as estratégias.')),
      h(
        'button',
        {
          class: ligada ? '' : 'perigo',
          onclick: async () => {
            if (!ligada || confirm('Desligar a parada geral? As estratégias ativas voltam a operar.')) {
              await tentar(() => api('POST', '/parada', { ligada: !ligada }), ligada ? 'Parada desligada' : 'Parada ligada');
              rota();
            }
          },
        },
        ligada ? 'Desligar parada' : 'PARAR TUDO',
      ),
    ),
    h(
      'div',
      { class: 'grade' },
      [
        ['Ordens hoje', fmt(r.hoje.ordens, 0)],
        ['Compras hoje', fmt(r.hoje.compras)],
        ['Vendas hoje', fmt(r.hoje.vendas)],
        ['Erros hoje', fmt(r.hoje.erros, 0)],
        ['Dinheiro real no servidor', r.real_no_servidor ? 'liberado' : 'desligado'],
      ].map(([rot, val]) => h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, rot), h('div', { class: 'numero' }, val))),
    ),
    h('h2', {}, 'Estratégias'),
    h(
      'div',
      { class: 'cartao' },
      tabela(
        [
          ['Nome', (e) => e.nome],
          ['Par', (e) => e.simbolo],
          ['Conta', (e) => e.conta],
          ['Modo', (e) => seloModo(e.real && e.conta_modo === 'real' && r.real_no_servidor ? 'real' : 'simulacao')],
          ['Ativa', (e) => (e.ativa ? selo('ativa', 'ok') : selo('parada', 'suave'))],
          ['Posição', (e) => qtd(e.posicao)],
          ['Custo da posição', (e) => fmt(e.custo_posicao)],
        ],
        r.estrategias,
        'Nenhuma estratégia. Crie uma conta e depois uma estratégia.',
      ),
    ),
  ];
}

async function paginaContas() {
  const [contas, exchanges] = await Promise.all([api('GET', '/contas'), api('GET', '/exchanges')]);
  const lista = h('datalist', { id: 'lista-exchanges' }, exchanges.map((e) => h('option', { value: e })));
  const form = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        const corpo = {
          nome: d.nome, exchange: d.exchange, modo: d.modo, testnet: d.testnet,
          api_key: d.api_key, api_secret: d.api_secret, api_senha: d.api_senha,
          taxa_simulada_pct: d.taxa_simulada_pct ?? 0.1,
          saldo_inicial: d.saldo_moeda && d.saldo_quantidade !== null ? { moeda: d.saldo_moeda, quantidade: d.saldo_quantidade } : undefined,
        };
        if (corpo.modo === 'real' && !confirm('Conta REAL: as chaves de API mandam ordens de verdade. Use chaves SEM permissão de saque. Continuar?')) return;
        if (await tentar(() => api('POST', '/contas', corpo), 'Conta criada')) rota();
      },
    },
    h(
      'div',
      { class: 'campos' },
      campo('Nome', { name: 'nome', required: true, placeholder: 'Binance principal' }),
      campo('Exchange (id do CCXT)', { name: 'exchange', list: 'lista-exchanges', required: true, placeholder: 'binance, mercado, bybit…' }),
      h('label', {}, 'Modo', h('select', { name: 'modo' }, h('option', { value: 'simulacao' }, 'Simulação'), h('option', { value: 'real' }, 'Real'))),
      campo('Taxa simulada (%)', { name: 'taxa_simulada_pct', type: 'number', step: '0.01', min: '0', value: '0.1' }),
      campo('Saldo simulado inicial: moeda', { name: 'saldo_moeda', placeholder: 'USDT ou BRL' }),
      campo('Saldo simulado inicial: quantidade', { name: 'saldo_quantidade', type: 'number', step: 'any', min: '0', placeholder: '1000' }),
    ),
    h('p', { class: 'rotulo' }, 'Chaves de API: só para modo real ou para consultar saldo. Crie a chave na exchange sem permissão de saque e, se der, restrita ao IP 77.42.120.142. Elas ficam cifradas e nunca voltam para a tela.'),
    h(
      'div',
      { class: 'campos' },
      campo('API key', { name: 'api_key', autocomplete: 'off' }),
      campo('API secret', { name: 'api_secret', type: 'password', autocomplete: 'off' }),
      campo('Senha da API (se a exchange pede)', { name: 'api_senha', type: 'password', autocomplete: 'off' }),
    ),
    caixa('Usar testnet da exchange (Binance, Bybit, OKX têm)', { name: 'testnet' }),
    h('div', { class: 'acoes' }, h('button', { type: 'submit' }, 'Criar conta')),
  );

  return [
    h('h1', {}, 'Contas'),
    h(
      'div',
      { class: 'cartao' },
      tabela(
        [
          ['Nome', (c) => c.nome],
          ['Exchange', (c) => c.exchange + (c.testnet ? ' (testnet)' : '')],
          ['Modo', (c) => seloModo(c.modo)],
          ['Chave', (c) => (c.tem_chave ? 'cadastrada' : '—')],
          ['', (c) => h('div', { class: 'acoes' },
            h('button', { class: 'pequeno secundario', onclick: () => testarConta(c) }, 'Testar'),
            h('button', { class: 'pequeno secundario', onclick: () => saldosConta(c) }, 'Saldo simulado'),
            h('button', { class: 'pequeno secundario', onclick: () => editarConta(c) }, 'Editar'),
          )],
        ],
        contas,
      ),
    ),
    h('h2', {}, 'Nova conta'),
    h('div', { class: 'cartao' }, lista, form),
  ];
}

async function testarConta(c) {
  const r = await tentar(() => api('POST', `/contas/${c.id}/testar`));
  if (!r) return;
  janela(
    `Teste: ${c.nome}`,
    h('p', {}, 'Cotação pública: ', r.publico === 'ok' ? selo('ok', 'ok') : h('span', { class: 'perigo-txt' }, r.publico)),
    r.privado !== undefined ? h('p', {}, 'Chave de API: ', r.privado === 'ok' ? selo('ok', 'ok') : h('span', { class: 'perigo-txt' }, r.privado)) : h('p', { class: 'suave' }, 'Sem chave de API cadastrada.'),
    r.saldos ? tabela([['Moeda', (l) => l[0]], ['Disponível', (l) => qtd(l[1])]], Object.entries(r.saldos), 'Saldo zerado.') : null,
  );
}

async function saldosConta(c) {
  const r = await tentar(() => api('GET', `/contas/${c.id}/saldos`));
  if (!r) return;
  const form = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        if (await tentar(() => api('PUT', `/contas/${c.id}/saldos/${encodeURIComponent(d.moeda)}`, { quantidade: d.quantidade }), 'Saldo definido')) {
          dlg.close();
          saldosConta(c);
        }
      },
    },
    h('div', { class: 'campos' }, campo('Moeda', { name: 'moeda', required: true }), campo('Quantidade', { name: 'quantidade', type: 'number', step: 'any', min: '0', required: true })),
    h('button', { type: 'submit' }, 'Definir saldo'),
  );
  const dlg = janela(`Saldo simulado: ${c.nome}`, tabela([['Moeda', (s) => s.moeda], ['Quantidade', (s) => qtd(s.quantidade)]], r.simulados, 'Sem saldo simulado.'), form);
}

function editarConta(c) {
  const form = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        if (d.modo === 'real' && c.modo !== 'real' && !confirm('Passar a conta para REAL? Estratégias marcadas como real passam a mandar ordens de verdade (se o servidor liberar).')) return;
        if (await tentar(() => api('PATCH', `/contas/${c.id}`, d), 'Conta atualizada')) {
          dlg.close();
          rota();
        }
      },
    },
    h(
      'div',
      { class: 'campos' },
      campo('Nome', { name: 'nome', value: c.nome }),
      h('label', {}, 'Modo', h('select', { name: 'modo' }, h('option', { value: 'simulacao', selected: c.modo === 'simulacao' }, 'Simulação'), h('option', { value: 'real', selected: c.modo === 'real' }, 'Real'))),
      campo('Taxa simulada (%)', { name: 'taxa_simulada_pct', type: 'number', step: '0.01', min: '0', value: c.taxa_simulada_pct }),
      campo('Nova API key', { name: 'api_key', autocomplete: 'off', placeholder: c.tem_chave ? 'deixe vazio para manter' : '' }),
      campo('Novo API secret', { name: 'api_secret', type: 'password', autocomplete: 'off' }),
      campo('Nova senha da API', { name: 'api_senha', type: 'password', autocomplete: 'off' }),
    ),
    caixa('Testnet', { name: 'testnet', checked: c.testnet }),
    caixa('Apagar as chaves cadastradas', { name: 'apagar_chaves' }),
    h('button', { type: 'submit' }, 'Salvar'),
  );
  const dlg = janela(`Editar: ${c.nome}`, form);
}

function exemploAlerta(webhook) {
  return [
    h('p', {}, 'URL do webhook (trate como senha: quem tem a URL manda sinais). Ela só aparece agora:'),
    h('pre', {}, webhook),
    h('div', { class: 'acoes' }, h('button', { class: 'pequeno', onclick: () => navigator.clipboard.writeText(webhook).then(() => avisar('Copiada')) }, 'Copiar URL')),
    h('p', {}, 'No alerta do TradingView, cole a URL em "Webhook URL" e use como mensagem, por exemplo:'),
    h('pre', {}, '{"acao":"comprar","simbolo":"{{ticker}}","preco":{{close}},"id":"{{timenow}}"}'),
    h('pre', {}, '{"acao":"zerar","simbolo":"{{ticker}}","id":"{{timenow}}"}'),
    h('p', { class: 'rotulo' }, 'Ações: comprar (gasta o valor da ordem), vender (a "quantidade" informada ou tudo), zerar (vende tudo). "valor", "quantidade", "preco" e "id" são opcionais; o "id" evita executar o mesmo alerta duas vezes.'),
  ];
}

function camposEstrategia(e = {}) {
  return h(
    'div',
    { class: 'campos' },
    campo('Nome', { name: 'nome', required: true, value: e.nome }),
    campo('Par (BASE/COTAÇÃO)', { name: 'simbolo', required: true, placeholder: 'BTC/USDT', value: e.simbolo }),
    campo('Valor por ordem (em cotação)', { name: 'valor_ordem', type: 'number', step: 'any', min: '0', required: true, value: e.valor_ordem }),
    campo('Limite por ordem', { name: 'limite_por_ordem', type: 'number', step: 'any', min: '0', required: true, value: e.limite_por_ordem }),
    campo('Limite de compras por dia', { name: 'limite_diario', type: 'number', step: 'any', min: '0', required: true, value: e.limite_diario }),
    campo('Limite da posição aberta (opcional)', { name: 'limite_posicao', type: 'number', step: 'any', min: '0', value: e.limite_posicao }),
    campo('Intervalo mínimo entre ordens (s)', { name: 'intervalo_min_seg', type: 'number', min: '0', value: e.intervalo_min_seg ?? 60 }),
    campo('Desvio máximo de preço (%)', { name: 'desvio_max_pct', type: 'number', step: '0.01', min: '0.01', value: e.desvio_max_pct ?? 1 }),
    campo('IPs permitidos (vírgula; vazio = qualquer)', { name: 'ips_permitidos', value: e.ips_permitidos, placeholder: '52.89.214.238, 34.212.75.30, 54.218.53.128, 52.32.178.7' }),
  );
}

async function paginaEstrategias() {
  const [estrategias, contas, resumo] = await Promise.all([api('GET', '/estrategias'), api('GET', '/contas'), faixa()]);
  const form = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        d.conta_id = Number(d.conta_id);
        d.ips_permitidos = d.ips_permitidos ?? null;
        const r = await tentar(() => api('POST', '/estrategias', d), 'Estratégia criada');
        if (r) {
          await rota();
          janela('Estratégia criada', ...exemploAlerta(r.webhook));
        }
      },
    },
    h('label', {}, 'Conta', h('select', { name: 'conta_id', required: true }, contas.map((c) => h('option', { value: c.id }, `${c.nome} (${c.exchange}, ${c.modo})`)))),
    camposEstrategia(),
    caixa('Ativar já', { name: 'ativa' }),
    h('div', { class: 'acoes' }, h('button', { type: 'submit', disabled: !contas.length }, 'Criar estratégia')),
  );

  const alternar = async (e, campoNome, valor, pergunta) => {
    if (pergunta && !confirm(pergunta)) return;
    if (await tentar(() => api('PATCH', `/estrategias/${e.id}`, { [campoNome]: valor }), 'Atualizado')) rota();
  };

  return [
    h('h1', {}, 'Estratégias'),
    h(
      'div',
      { class: 'cartao' },
      tabela(
        [
          ['Nome', (e) => h('div', {}, e.nome, h('div', { class: 'rotulo mono' }, `token ${e.token_prefixo}…`))],
          ['Par / conta', (e) => h('div', {}, e.simbolo, h('div', { class: 'rotulo' }, `${e.conta} · ${e.exchange}`))],
          ['Limites', (e) => h('div', { class: 'rotulo' }, `ordem ${fmt(e.valor_ordem)} (máx ${fmt(e.limite_por_ordem)}) · dia ${fmt(e.limite_diario)}`, e.limite_posicao ? ` · posição ${fmt(e.limite_posicao)}` : '')],
          ['Posição', (e) => h('div', {}, qtd(e.posicao), h('div', { class: 'rotulo' }, `custo ${fmt(e.custo_posicao)}`))],
          ['Estado', (e) => h('div', { class: 'acoes' }, e.ativa ? selo('ativa', 'ok') : selo('parada', 'suave'), seloModo(e.real && e.conta_modo === 'real' && resumo.real_no_servidor ? 'real' : 'simulacao'))],
          ['', (e) => h('div', { class: 'acoes' },
            h('button', { class: 'pequeno secundario', onclick: () => alternar(e, 'ativa', !e.ativa) }, e.ativa ? 'Desativar' : 'Ativar'),
            e.conta_modo === 'real'
              ? h('button', { class: `pequeno ${e.real ? 'secundario' : 'perigo'}`, onclick: () => alternar(e, 'real', !e.real, e.real ? null : `Ligar dinheiro REAL em "${e.nome}"? Cada sinal aceito vira ordem de verdade na ${e.exchange}, dentro dos limites.`) }, e.real ? 'Voltar a simular' : 'Operar real')
              : null,
            h('button', { class: 'pequeno secundario', onclick: () => editarEstrategia(e) }, 'Editar'),
            h('button', { class: 'pequeno secundario', onclick: () => cotacao(e) }, 'Cotação'),
            h('button', { class: 'pequeno secundario', onclick: () => novoToken(e) }, 'Novo token'),
          )],
        ],
        estrategias,
      ),
    ),
    h('h2', {}, 'Nova estratégia'),
    h('div', { class: 'cartao' }, contas.length ? form : h('p', { class: 'suave' }, 'Crie uma conta primeiro.')),
  ];
}

function editarEstrategia(e) {
  const form = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        d.ips_permitidos = d.ips_permitidos ?? null;
        if (await tentar(() => api('PATCH', `/estrategias/${e.id}`, d), 'Estratégia atualizada')) {
          dlg.close();
          rota();
        }
      },
    },
    camposEstrategia(e),
    h('button', { type: 'submit' }, 'Salvar'),
  );
  const dlg = janela(`Editar: ${e.nome}`, form);
}

async function cotacao(e) {
  const r = await tentar(() => api('GET', `/estrategias/${e.id}/cotacao`));
  if (r) avisar(`${r.simbolo}: ${fmt(r.cotacao, 8)}`);
}

async function novoToken(e) {
  if (!confirm(`Gerar um token novo para "${e.nome}"? A URL antiga para de funcionar na hora e o alerta do TradingView precisa ser atualizado.`)) return;
  const r = await tentar(() => api('POST', `/estrategias/${e.id}/novo-token`));
  if (r) janela('Token novo', ...exemploAlerta(r.webhook));
}

async function paginaSinais() {
  const sinais = await api('GET', '/sinais?limite=200');
  return [
    h('h1', {}, 'Sinais recebidos'),
    h(
      'div',
      { class: 'cartao' },
      tabela(
        [
          ['Quando', (s) => data(s.recebido_em)],
          ['Estratégia', (s) => s.estrategia ?? '—'],
          ['Ação', (s) => s.acao ?? '—'],
          ['Situação', (s) => seloSituacao(s.situacao)],
          ['Motivo', (s) => s.motivo ?? ''],
          ['IP', (s) => h('span', { class: 'mono' }, s.ip ?? '')],
          ['Corpo', (s) => h('code', {}, JSON.stringify(s.corpo))],
        ],
        sinais,
        'Nenhum sinal recebido ainda.',
      ),
    ),
  ];
}

async function paginaOrdens() {
  const ordens = await api('GET', '/ordens?limite=200');
  return [
    h('h1', {}, 'Ordens'),
    h(
      'div',
      { class: 'cartao' },
      tabela(
        [
          ['Quando', (o) => data(o.criada_em)],
          ['Estratégia', (o) => o.estrategia],
          ['Modo', (o) => seloModo(o.modo)],
          ['Lado', (o) => o.lado],
          ['Par', (o) => o.simbolo],
          ['Quantidade', (o) => qtd(o.quantidade)],
          ['Preço médio', (o) => fmt(o.preco_medio, 8)],
          ['Total', (o) => fmt(o.custo)],
          ['Taxa', (o) => fmt(o.taxa, 6)],
          ['Situação', (o) => h('div', {}, seloSituacao(o.situacao), o.erro ? h('div', { class: 'rotulo perigo-txt' }, o.erro) : null)],
          ['Id na exchange', (o) => h('span', { class: 'mono' }, o.id_exchange ?? '')],
        ],
        ordens,
        'Nenhuma ordem ainda.',
      ),
    ),
  ];
}

async function paginaAuditoria() {
  const eventos = await api('GET', '/eventos');
  return [
    h('h1', {}, 'Auditoria'),
    h(
      'div',
      { class: 'cartao' },
      tabela(
        [
          ['Quando', (e) => data(e.criado_em)],
          ['Quem', (e) => e.email ?? 'sistema'],
          ['O quê', (e) => e.tipo],
          ['Detalhe', (e) => h('code', {}, JSON.stringify(e.detalhe))],
        ],
        eventos,
      ),
    ),
  ];
}

// ------------------------------------------------------------------ rotas

async function paginaEscritorio() {
  const { montarEscritorio } = await import('./escritorio/escritorio.js');
  const caixa = h('div');
  const escritorio = montarEscritorio(caixa);
  limparPagina = () => escritorio.parar();
  return [h('h1', {}, 'Escritório'), caixa];
}

const paginas = {
  '#/painel': paginaPainel,
  '#/escritorio': paginaEscritorio,
  '#/estrategias': paginaEstrategias,
  '#/contas': paginaContas,
  '#/sinais': paginaSinais,
  '#/ordens': paginaOrdens,
  '#/auditoria': paginaAuditoria,
};

// a página do escritório anima um canvas: precisa parar o laço ao trocar de página
let limparPagina = null;

async function rota() {
  limparPagina?.();
  limparPagina = null;
  const chave = paginas[location.hash] ? location.hash : '#/painel';
  for (const a of document.querySelectorAll('header a')) a.classList.toggle('ativo', a.getAttribute('href') === chave);
  try {
    conteudo.replaceChildren(...(await paginas[chave]()));
  } catch (e) {
    if (e.message !== 'sessão expirou') conteudo.replaceChildren(h('p', { class: 'perigo-txt' }, e.message));
  }
}

async function iniciar() {
  try {
    const s = await api('GET', '/sessao');
    $('#quem').textContent = s.email;
    $('#topo').hidden = false;
    window.onhashchange = rota;
    await rota();
  } catch {
    // mostrarLogin já foi chamado pelo 401
  }
}

iniciar();
