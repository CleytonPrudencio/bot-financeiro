import {
  api, avatar, botao, botaoIcone, cabecalho, campo, confirmar, copiar, escalonar, escolha, fmt, h, icone, interruptor, janela,
  lerForm, qtd, relativo, secao, selo, seloModo, tentar, vazio,
} from '../base.js';

function tabelaSimples(colunas, linhas, textoVazio) {
  if (!linhas.length) return h('p', { class: 'suave' }, textoVazio);
  return h('div', { class: 'tabela-caixa' }, h('table', { class: 'tabela' },
    h('thead', {}, h('tr', {}, colunas.map((c) => h('th', {}, c[0])))),
    h('tbody', {}, linhas.map((l) => h('tr', {}, colunas.map((c) => h('td', {}, c[1](l))))))));
}

// As mais usadas no Brasil primeiro; o resto do CCXT vem depois, em ordem alfabética.
const PRINCIPAIS = ['binance', 'mt5', 'mercado', 'bybit', 'okx', 'foxbit', 'bitso', 'bitget', 'kucoin', 'coinbase', 'kraken'];

// Lista fechada (select), e não campo de texto: o Chrome preenchia o e-mail salvo no campo da
// exchange por achar que o formulário com senha era de login.
function seletorExchange(exchanges) {
  const principais = PRINCIPAIS.filter((e) => exchanges.includes(e));
  const resto = exchanges.filter((e) => !principais.includes(e));
  return h('label', { class: 'campo' },
    h('span', { class: 'campo-rotulo' }, 'Exchange'),
    h('select', { name: 'exchange', required: true },
      h('optgroup', { label: 'Principais' }, principais.map((e, i) => h('option', { value: e, selected: i === 0 }, e === 'mt5' ? 'mt5 · MetaTrader 5 (ações da B3: XP, Clear…)' : e))),
      h('optgroup', { label: 'Todas do CCXT' }, resto.map((e) => h('option', { value: e }, e)))));
}

/** Depois de criar a conta MetaTrader 5: o token da ponte (só agora) e como instalar no Windows. */
function janelaPonte(r) {
  const env = `BOT_URL=${r.url_bot}\nPONTE_TOKEN=${r.ponte_token}\nPONTE_VALOR_MAX=200`;
  janela('Ponte MetaTrader 5', { icone: 'chave', largura: 'grande', subtitulo: 'Ações da B3 pela sua corretora, com o MT5 aberto no Windows' },
    h('div', { class: 'destaque destaque-alerta' }, icone('chave'), h('div', {}, h('strong', {}, 'Guarde o token agora'), h('p', {}, 'Ele é a senha da ponte e não aparece de novo (no banco fica só o hash). Se perder, gere outro no cartão da conta.'))),
    h('h3', {}, '1. Baixe os arquivos da ponte numa pasta do seu Windows'),
    h('div', { class: 'acoes' },
      ['ponte.py', 'iniciar.bat', 'ponte.env.exemplo', 'LEIAME.txt'].map((arq) => h('a', { class: 'botao pequeno secundario', href: `/ponte-mt5/${arq}`, download: arq }, icone('seta'), h('span', {}, arq)))),
    h('h3', {}, '2. Crie o arquivo ponte.env (na mesma pasta) com isto'),
    h('div', { class: 'copiavel' }, h('pre', { class: 'codigo' }, env), botao('Copiar', { classe: 'pequeno', nomeIcone: 'copiar', onclick: () => copiar(env, 'Configuração copiada') })),
    h('h3', {}, '3. Abra o MetaTrader 5 da corretora, faça login e ligue o "Algo Trading"'),
    h('h3', {}, '4. Dê dois cliques em iniciar.bat'),
    h('p', { class: 'suave' }, `Já criei a estratégia "Piloto B3" em simulação, varrendo as ações mais negociadas. Quando a ponte conectar, o cartão desta conta mostra "ponte conectada" e o saldo da corretora. A ponte só executa o que o bot aprovou, recusa ordem com mais de 20 s e compra acima do teto PONTE_VALOR_MAX.`),
  );
}

function novaConta(exchanges, recarregar) {
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        const corpo = {
          nome: d.nome, exchange: d.exchange, modo: d.modo, testnet: d.testnet,
          api_key: d.api_key, api_secret: d.api_secret, api_senha: d.api_senha,
          taxa_simulada_pct: d.taxa_simulada_pct ?? 0.1,
          saldo_inicial: d.saldo_moeda && d.saldo_quantidade !== null ? { moeda: d.saldo_moeda, quantidade: d.saldo_quantidade } : undefined,
        };
        const ehMt5 = corpo.exchange === 'mt5';
        if (corpo.modo === 'real' && !(await confirmar('Criar conta REAL?', ehMt5 ? 'As ordens aprovadas pelo bot vão para a sua corretora pela ponte MetaTrader 5.' : 'As chaves de API mandam ordens de verdade. Use chaves SEM permissão de saque e, se der, restritas ao IP 77.42.120.142.', { perigo: true, botao: 'Criar conta real' }))) return;
        const r = await tentar(() => api('POST', '/contas', corpo), 'Conta criada');
        if (r) {
          dlg.fechar();
          recarregar();
          if (r.ponte_token) janelaPonte(r);
        }
      },
    },
    secao('Conta',
      campo('Nome', { name: 'nome', required: true, placeholder: 'Binance principal' }),
      seletorExchange(exchanges),
      escolha('Modo', 'modo', [['simulacao', 'Simulação'], ['real', 'Real']], 'simulacao'),
      campo('Taxa simulada (%)', { name: 'taxa_simulada_pct', type: 'number', step: '0.01', min: '0', value: '0.1' }),
    ),
    secao('Saldo simulado inicial',
      campo('Moeda', { name: 'saldo_moeda', placeholder: 'USDT ou BRL' }),
      campo('Quantidade', { name: 'saldo_quantidade', type: 'number', step: 'any', min: '0', placeholder: '1000' }),
    ),
    h('div', { class: 'destaque' }, icone('escritorio'), h('p', {}, 'Ações da B3 (XP e outras corretoras com MetaTrader 5): escolha "mt5" na exchange. Não precisa de chave de API: depois de criar, o painel mostra um token e como ligar a ponte no seu Windows.')),
    h('div', { class: 'destaque' }, icone('chave'), h('p', {}, 'Chaves de API: só para modo real ou para consultar saldo. Crie a chave na exchange sem permissão de saque e, se der, restrita ao IP 77.42.120.142. Elas ficam cifradas e nunca voltam para a tela.')),
    secao('Chaves de API',
      campo('API key', { name: 'api_key', autocomplete: 'off' }),
      campo('API secret', { name: 'api_secret', type: 'password', autocomplete: 'new-password' }),
      campo('Senha da API', { name: 'api_senha', type: 'password', autocomplete: 'new-password' }, 'se a exchange pede'),
    ),
    interruptor('Usar testnet da exchange', { name: 'testnet' }, 'Binance, Bybit e OKX têm'),
    h('div', { class: 'acoes acoes-fim' }, h('button', { class: 'botao', type: 'submit' }, icone('ok'), h('span', {}, 'Criar conta'))),
  );
  const dlg = janela('Nova conta', { icone: 'contas', largura: 'grande', subtitulo: 'Uma conta numa exchange: simulada (saldo de mentira) ou real (com chaves)' }, form);
}

async function testarConta(c) {
  const r = await tentar(() => api('POST', `/contas/${c.id}/testar`));
  if (!r) return;
  janela(`Teste: ${c.nome}`, { icone: 'testar' },
    h('div', { class: 'checagens' },
      h('div', { class: 'checagem' }, r.publico === 'ok' ? selo('ok', 'ok', 'ok') : selo('falhou', 'perigo', 'alerta'), h('span', {}, 'Cotação pública'), r.publico === 'ok' ? null : h('small', { class: 'perigo-txt' }, r.publico)),
      r.privado !== undefined
        ? h('div', { class: 'checagem' }, r.privado === 'ok' ? selo('ok', 'ok', 'ok') : selo('falhou', 'perigo', 'alerta'), h('span', {}, 'Chave de API'), r.privado === 'ok' ? null : h('small', { class: 'perigo-txt' }, r.privado))
        : h('div', { class: 'checagem suave' }, selo('sem chave', 'neutro'), h('span', {}, 'Nenhuma chave cadastrada')),
    ),
    r.saldos ? tabelaSimples([['Moeda', (l) => l[0]], ['Disponível', (l) => h('span', { class: 'mono' }, qtd(l[1]))]], Object.entries(r.saldos), 'Saldo zerado.') : null,
  );
}

async function saldosConta(c) {
  const r = await tentar(() => api('GET', `/contas/${c.id}/saldos`));
  if (!r) return;
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        if (await tentar(() => api('PUT', `/contas/${c.id}/saldos/${encodeURIComponent(d.moeda)}`, { quantidade: d.quantidade }), 'Saldo definido')) {
          dlg.fechar();
          saldosConta(c);
        }
      },
    },
    h('div', { class: 'campos' }, campo('Moeda', { name: 'moeda', required: true, placeholder: 'USDT' }), campo('Quantidade', { name: 'quantidade', type: 'number', step: 'any', min: '0', required: true })),
    h('div', { class: 'acoes acoes-fim' }, h('button', { class: 'botao', type: 'submit' }, 'Definir saldo')),
  );
  const dlg = janela(`Saldo simulado: ${c.nome}`, { icone: 'contas' },
    tabelaSimples([['Moeda', (s) => h('strong', {}, s.moeda)], ['Quantidade', (s) => h('span', { class: 'mono' }, qtd(s.quantidade))]], r.simulados, 'Sem saldo simulado.'),
    h('h3', {}, 'Definir saldo de uma moeda'),
    form,
  );
}

function editarConta(c, recarregar) {
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        if (d.modo === 'real' && c.modo !== 'real' && !(await confirmar('Passar a conta para REAL?', 'Estratégias marcadas como real passam a mandar ordens de verdade (se o servidor liberar).', { perigo: true, botao: 'Passar para real' }))) return;
        if (!d.apagar_chaves) delete d.apagar_chaves;
        if (await tentar(() => api('PATCH', `/contas/${c.id}`, d), 'Conta atualizada')) {
          dlg.fechar();
          recarregar();
        }
      },
    },
    secao('Conta',
      campo('Nome', { name: 'nome', value: c.nome }),
      escolha('Modo', 'modo', [['simulacao', 'Simulação'], ['real', 'Real']], c.modo),
      campo('Taxa simulada (%)', { name: 'taxa_simulada_pct', type: 'number', step: '0.01', min: '0', value: c.taxa_simulada_pct }),
    ),
    secao('Trocar chaves',
      campo('Nova API key', { name: 'api_key', autocomplete: 'off', placeholder: c.tem_chave ? 'vazio = mantém a atual' : '' }),
      campo('Novo API secret', { name: 'api_secret', type: 'password', autocomplete: 'new-password' }),
      campo('Nova senha da API', { name: 'api_senha', type: 'password', autocomplete: 'new-password' }),
    ),
    interruptor('Testnet', { name: 'testnet', checked: c.testnet }),
    interruptor('Apagar as chaves cadastradas', { name: 'apagar_chaves' }),
    h('div', { class: 'acoes acoes-fim' }, h('button', { class: 'botao', type: 'submit' }, icone('ok'), h('span', {}, 'Salvar'))),
  );
  const dlg = janela(`Editar ${c.nome}`, { icone: 'editar', largura: 'grande', subtitulo: c.exchange }, form);
}

/** Ponte conectada: falou com o bot nos últimos 3 minutos. */
function seloPonte(p) {
  if (!p.visto_em) return selo('ponte nunca conectou', 'neutro', 'alerta');
  const conectada = Date.now() - new Date(p.visto_em).getTime() < 3 * 60_000;
  return conectada ? selo('ponte conectada', 'ok', 'ok') : selo(`ponte sem contato ${relativo(p.visto_em)}`, 'perigo', 'alerta');
}

async function novoTokenPonte(c) {
  if (!(await confirmar('Gerar um token novo da ponte?', 'A ponte que está rodando para de funcionar até você trocar o PONTE_TOKEN no ponte.env.', { perigo: true, botao: 'Gerar token' }))) return;
  const r = await tentar(() => api('POST', `/contas/${c.id}/novo-token-ponte`));
  if (r) janelaPonte(r);
}

export async function paginaContas({ recarregar }) {
  const [contas, exchanges] = await Promise.all([api('GET', '/contas'), api('GET', '/exchanges')]);
  const nova = () => novaConta(exchanges, recarregar);
  return [
    cabecalho('Contas', 'Exchanges conectadas via CCXT e corretoras da B3 pela ponte MetaTrader 5. Em simulação usam cotação real e saldo de mentira.', botao('Nova conta', { nomeIcone: 'mais', onclick: nova })),
    contas.length
      ? h('div', { class: 'grade-cartoes' }, escalonar(contas.map((c) =>
          h('article', { class: `cartao cartao-conta ${c.modo === 'real' ? 'em-real' : ''}` },
            h('div', { class: 'cartao-conta-topo' }, avatar(c.exchange, 'avatar-grande'), h('div', {}, h('h3', {}, c.nome), h('span', { class: 'suave' }, c.exchange + (c.testnet ? ' · testnet' : '')))),
            h('div', { class: 'fichas' }, seloModo(c.modo),
              c.ponte ? seloPonte(c.ponte) : c.tem_chave ? selo('chave cadastrada', 'ok', 'chave') : selo('sem chave', 'neutro'),
              selo(`taxa ${fmt(c.taxa_simulada_pct)}%`, 'neutro')),
            c.ponte?.corretora ? h('p', { class: 'pequeno-texto suave' }, `${c.ponte.corretora} · ${c.ponte.servidor ?? ''}${c.ponte.saldo !== null ? ` · saldo R$ ${fmt(c.ponte.saldo)}` : ''}`) : null,
            h('div', { class: 'cartao-acoes' },
              botao('Testar', { classe: 'pequeno secundario', nomeIcone: 'testar', onclick: () => testarConta(c) }),
              botao('Saldo simulado', { classe: 'pequeno secundario', nomeIcone: 'contas', onclick: () => saldosConta(c) }),
              c.ponte ? botaoIcone('chave', 'Gerar novo token da ponte', { onclick: () => novoTokenPonte(c) }) : null,
              h('span', { class: 'espaco' }),
              botaoIcone('editar', 'Editar', { onclick: () => editarConta(c, recarregar) }),
            ),
          ))))
      : vazio('Nenhuma conta', 'Comece com uma conta em simulação: ela usa a cotação pública e um saldo de mentira.', 'contas', botao('Nova conta', { nomeIcone: 'mais', onclick: nova })),
  ];
}
