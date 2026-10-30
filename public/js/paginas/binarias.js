import { api, botao, botaoIcone, cabecalho, campo, confirmar, copiar, data, escolha, fmt, h, icone, inteiro, interruptor, janela, lerForm, relativo, secao, selo, seloModo, tentar, vazio } from '../base.js';
import { barraUso } from '../graficos.js';

// Opções binárias na Quotex, pela ponte no computador do dono. A Quotex não tem API oficial: a
// ponte usa a biblioteca pyquotex com o login dele. Simulação = conta demo da Quotex.

const DIRECAO = { call: 'CALL ↑', put: 'PUT ↓' };
const SITUACAO = {
  pendente: ['pedida', 'alerta'], enviada: ['na ponte', 'alerta'], aberta: ['correndo', 'alerta'],
  ganhou: ['ganhou', 'ok'], perdeu: ['perdeu', 'perigo'], empate: ['empate', 'neutro'], erro: ['erro', 'perigo'], expirada: ['expirou', 'neutro'],
};
const ESTILOS = [['repique', 'Repique (aposta na volta depois do exagero)'], ['tendencia', 'Tendência (aposta a favor do movimento)']];
const PRAZOS = [[60, '1 minuto'], [120, '2 minutos'], [180, '3 minutos'], [300, '5 minutos']];

/** Com este payout (%), quanto é preciso acertar só para empatar. */
const empate = (payout) => 100 / (1 + Number(payout) / 100);
const pct1 = (v) => `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

function janelaPonte(r) {
  const env = `BOT_URL=${r.url_bot}\nPONTE_TOKEN=${r.ponte_token}\nQUOTEX_EMAIL=\nQUOTEX_SENHA=\nPONTE_CONTA=demo\nPONTE_VALOR_MAX=10`;
  janela('Ponte Quotex', { icone: 'chave', largura: 'grande', subtitulo: 'Roda no seu computador, com o seu login da Quotex' },
    h('div', { class: 'destaque destaque-alerta' }, icone('chave'), h('div', {}, h('strong', {}, 'Guarde o token agora'), h('p', {}, 'Ele é a senha da ponte e não aparece de novo (no banco fica só o hash). Se perder, gere outro no cartão da conta.'))),
    h('h3', {}, '1. Instale o Python 3.12 ou mais novo (python.org), marcando "Add Python to PATH"'),
    h('h3', {}, '2. Baixe os arquivos da ponte numa pasta'),
    h('div', { class: 'acoes' },
      ['ponte.py', 'iniciar.bat', 'ponte.env.exemplo', 'LEIAME.txt'].map((arq) => h('a', { class: 'botao pequeno secundario', href: `/ponte-quotex/${arq}`, download: arq }, icone('seta'), h('span', {}, arq)))),
    h('h3', {}, '3. Crie o arquivo ponte.env (na mesma pasta) com isto, e preencha seu e-mail e senha da Quotex'),
    h('div', { class: 'copiavel' }, h('pre', { class: 'codigo' }, env), botao('Copiar', { classe: 'pequeno', nomeIcone: 'copiar', onclick: () => copiar(env, 'Configuração copiada') })),
    h('p', { class: 'suave' }, 'O e-mail e a senha ficam só no seu computador: a ponte usa para entrar na Quotex e nunca manda para o bot.'),
    h('h3', {}, '4. Dê dois cliques em iniciar.bat'),
    h('p', { class: 'suave' }, 'Na primeira vez a Quotex pode mandar um código por e-mail: a janela pede, você digita. Já criei uma estratégia desligada em EUR/USD (OTC): ative quando a ponte aparecer "ligada" aqui.'),
  );
}

function formEstrategia(b, { contas, mercado }, aoSalvar) {
  const novo = !b;
  const ativos = mercado.filter((m) => m.aberto || m.ativo === b?.ativo);
  const opcoesAtivo = ativos.length
    ? ativos.map((m) => [m.ativo, `${m.nome ?? m.ativo}${m.payout_5m !== null || m.payout_1m !== null ? ` · ${m.payout_5m ?? m.payout_1m}%` : ''}${m.aberto ? '' : ' (fechado)'}`])
    : [[b?.ativo ?? 'EURUSD_otc', b?.ativo ?? 'EURUSD_otc']];
  const form = h('form', {
    class: 'form',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const d = lerForm(form);
      const corpo = {
        nome: d.nome, ativo: d.ativo, estilo: d.estilo, prazo_s: Number(d.prazo_s), valor: d.valor, payout_min: d.payout_min,
        max_apostas_dia: d.max_apostas_dia, perda_max_dia: d.perda_max_dia, perdas_seguidas_max: d.perdas_seguidas_max,
        intervalo_min_seg: d.intervalo_min_seg,
      };
      if (novo) Object.assign(corpo, { conta_id: Number(d.conta_id), ativa: d.ativa });
      if (await tentar(() => (novo ? api('POST', '/binarias', corpo) : api('PATCH', `/binarias/${b.id}`, corpo)), novo ? 'Estratégia criada' : 'Estratégia salva')) aoSalvar();
    },
  },
  secao('Estratégia',
    campo('Nome', { name: 'nome', required: true, value: b?.nome ?? '', placeholder: 'Binárias EUR/USD' }),
    novo ? escolha('Conta Quotex', 'conta_id', contas.map((c) => [c.id, c.nome]), contas[0]?.id) : null,
    escolha('Ativo', 'ativo', opcoesAtivo, b?.ativo ?? opcoesAtivo[0][0], 'os abertos agora, do maior payout para o menor'),
    escolha('Estilo', 'estilo', ESTILOS, b?.estilo ?? 'repique'),
    escolha('Prazo', 'prazo_s', PRAZOS, b?.prazo_s ?? 300, 'em 1 min o preço é quase cara ou coroa'),
    novo ? interruptor('Ativar já', { name: 'ativa' }, 'começa a apostar na conta demo assim que a ponte estiver ligada') : null),
  secao('Risco',
    campo('Valor por aposta', { name: 'valor', type: 'number', step: '0.01', min: '1', required: true, value: b ? Number(b.valor) : 5 }, 'sempre o mesmo: o bot nunca dobra depois de perder'),
    campo('Payout mínimo (%)', { name: 'payout_min', type: 'number', step: '1', min: '50', max: '100', required: true, value: b ? Number(b.payout_min) : 85 }, 'abaixo disso não aposta'),
    campo('Apostas por dia (máx.)', { name: 'max_apostas_dia', type: 'number', step: '1', min: '1', max: '200', required: true, value: b?.max_apostas_dia ?? 10 }),
    campo('Perda máxima no dia', { name: 'perda_max_dia', type: 'number', step: '0.01', min: '1', required: true, value: b ? Number(b.perda_max_dia) : 15 }, 'chegou nela, para até amanhã'),
    campo('Perdas seguidas (máx.)', { name: 'perdas_seguidas_max', type: 'number', step: '1', min: '1', max: '20', required: true, value: b?.perdas_seguidas_max ?? 3 }, 'depois de tantas, para até amanhã'),
    campo('Intervalo entre apostas (s)', { name: 'intervalo_min_seg', type: 'number', step: '1', min: '0', required: true, value: b?.intervalo_min_seg ?? 300 })),
  h('div', { class: 'acoes acoes-fim' }, botao(novo ? 'Criar estratégia' : 'Salvar', { nomeIcone: 'ok', type: 'submit' })));
  return form;
}

function abrirForm(b, dados, recarregar) {
  const dlg = janela(b ? `Editar ${b.nome}` : 'Nova estratégia de binárias', { icone: b ? 'editar' : 'mais', largura: 'grande' },
    formEstrategia(b, dados, () => {
      dlg.fechar();
      recarregar();
    }));
}

function cartaoConta(c, recarregar) {
  const alterar = async (mudar, sucesso) => (await tentar(() => api('PATCH', `/binarias/contas/${c.id}`, mudar), sucesso)) && recarregar();
  return h('article', { class: `cartao ${c.modo === 'real' ? 'em-real' : ''}` },
    h('div', { class: 'cartao-estrategia-topo' },
      h('div', {}, h('span', { class: 'par' }, 'Quotex'), h('h3', {}, c.nome), h('span', { class: 'suave' }, `token ${c.token_prefixo ?? '?'}…`)),
      c.online ? selo('ponte ligada', 'ok', 'ok') : selo(c.visto_em ? `ponte parada (${relativo(c.visto_em)})` : 'ponte nunca ligou', 'neutro')),
    h('div', { class: 'fichas' },
      seloModo(c.modo),
      c.conta ? selo(`ponte na conta ${c.conta}`, c.conta === 'real' ? 'perigo' : 'alerta') : null),
    h('div', { class: 'numeros' },
      h('div', {}, h('span', { class: 'suave' }, `Saldo ${c.conta ?? ''}`), h('strong', { class: 'mono' }, c.saldo === null ? '—' : fmt(c.saldo)))),
    h('div', { class: 'cartao-acoes' },
      botaoIcone('chave', 'Gerar novo token', {
        onclick: async () => {
          if (!(await confirmar('Gerar um token novo?', 'A ponte com o token antigo para de funcionar na hora: troque o PONTE_TOKEN no ponte.env.', { perigo: true, botao: 'Gerar token' }))) return;
          const r = await tentar(() => api('POST', `/binarias/contas/${c.id}/novo-token`));
          if (r) janelaPonte(r);
        },
      }),
      h('span', { class: 'espaco' }),
      botao(c.modo === 'real' ? 'Voltar para demo' : 'Liberar conta real', {
        classe: `pequeno ${c.modo === 'real' ? 'secundario' : 'perigo'}`,
        nomeIcone: c.modo === 'real' ? 'escudo' : 'energia',
        onclick: async () => {
          if (c.modo !== 'real' && !(await confirmar('Liberar dinheiro REAL na Quotex?',
            'É a segunda das três chaves. A aposta real só sai com a estratégia também em real, BOT_LIVE_ENABLED no servidor e a ponte com PONTE_CONTA=real. Cada aposta perdida leva o valor inteiro.',
            { perigo: true, botao: 'Liberar conta real' }))) return;
          alterar({ modo: c.modo === 'real' ? 'simulacao' : 'real' }, c.modo === 'real' ? 'Conta voltou para demo' : 'Conta real liberada');
        },
      })));
}

function cartaoEstrategia(b, dados, recarregar) {
  const real = b.real && b.conta_modo === 'real' && dados.real_no_servidor;
  const alterar = async (mudar, sucesso) => (await tentar(() => api('PATCH', `/binarias/${b.id}`, mudar), sucesso)) && recarregar();
  const feitas = b.ganhou + b.perdeu;
  const acerto = feitas ? (b.ganhou / feitas) * 100 : null;
  const precisa = empate(b.payout_min);
  return h('article', { class: `cartao cartao-estrategia ${b.ativa ? '' : 'desligada'} ${real ? 'em-real' : ''}` },
    h('div', { class: 'cartao-estrategia-topo' },
      h('div', {}, h('span', { class: 'par' }, b.ativo), h('h3', {}, b.nome), h('span', { class: 'suave' }, `${b.conta} · ${b.estilo === 'tendencia' ? 'tendência' : 'repique'} · ${b.prazo_s / 60} min`)),
      h('label', { class: 'interruptor interruptor-so', title: b.ativa ? 'Desativar' : 'Ativar' },
        h('input', { type: 'checkbox', checked: b.ativa, onchange: (ev) => alterar({ ativa: ev.target.checked }, ev.target.checked ? 'Estratégia ativada' : 'Estratégia desativada') }),
        h('span', { class: 'interruptor-trilho' }, h('span', { class: 'interruptor-bola' })))),
    h('div', { class: 'fichas' },
      b.ativa ? selo('ativa', 'ok') : selo('parada', 'neutro'),
      real ? selo('REAL', 'perigo') : selo('demo', 'alerta'),
      selo(`${fmt(b.valor)} por aposta · payout ≥ ${Number(b.payout_min)}%`, 'neutro')),
    b.situacao ? h('p', { class: 'pequeno-texto suave piloto-situacao' }, `${relativo(b.checado_em)}: ${b.situacao}`) : null,
    h('div', { class: 'numeros' },
      h('div', {}, h('span', { class: 'suave' }, 'Acerto'), h('strong', { class: 'mono' }, acerto === null ? '—' : pct1(acerto))),
      h('div', {}, h('span', { class: 'suave' }, 'Precisa de'), h('strong', { class: 'mono' }, `> ${pct1(precisa)}`)),
      h('div', {}, h('span', { class: 'suave' }, 'Resultado'), h('strong', { class: `mono ${Number(b.lucro_total) < 0 ? 'negativo' : 'positivo'}` }, fmt(b.lucro_total)))),
    h('p', { class: 'pequeno-texto suave' }, `${b.ganhou} ganhas, ${b.perdeu} perdidas no total · hoje: ${fmt(b.lucro_hoje)}`),
    barraUso(b.apostas_hoje, b.max_apostas_dia, 'Apostas hoje / máximo', inteiro),
    h('div', { class: 'cartao-acoes' },
      botaoIcone('editar', 'Editar', { onclick: () => abrirForm(b, dados, recarregar) }),
      botaoIcone('apagar', 'Apagar', {
        onclick: async () => {
          if (!(await confirmar('Apagar a estratégia?', `"${b.nome}" some do painel. Com apostas no histórico, só dá para desativar.`, { perigo: true, botao: 'Apagar' }))) return;
          if (await tentar(() => api('DELETE', `/binarias/${b.id}`), 'Estratégia apagada')) recarregar();
        },
      }),
      h('span', { class: 'espaco' }),
      b.conta_modo === 'real'
        ? botao(b.real ? 'Voltar para demo' : 'Apostar real', {
            classe: `pequeno ${b.real ? 'secundario' : 'perigo'}`,
            nomeIcone: b.real ? 'escudo' : 'energia',
            onclick: async () => {
              if (!b.real && !(await confirmar('Apostar dinheiro REAL?',
                `Cada sinal de "${b.nome}" vira uma aposta de ${fmt(b.valor)} de verdade, até ${b.max_apostas_dia} por dia e perda de ${fmt(b.perda_max_dia)}. Acerto até agora: ${acerto === null ? 'nenhuma aposta ainda' : pct1(acerto)}; para empatar com payout de ${Number(b.payout_min)}% é preciso mais de ${pct1(precisa)}.`,
                { perigo: true, botao: 'Apostar com dinheiro real' }))) return;
              alterar({ real: !b.real }, b.real ? 'Estratégia voltou para demo' : 'Dinheiro real ligado nesta estratégia');
            },
          })
        : null));
}

function tabelaApostas(apostas) {
  const colunas = [
    ['Quando', (a) => data(a.criada_em)],
    ['Estratégia', (a) => a.estrategia],
    ['Ativo', (a) => a.ativo],
    ['Aposta', (a) => `${DIRECAO[a.direcao]} · ${a.prazo_s / 60} min`],
    ['Valor', (a) => fmt(a.valor), 'num mono'],
    ['Payout', (a) => `${Number(a.payout)}%`, 'num mono'],
    ['Conta', (a) => (a.modo === 'real' ? selo('real', 'perigo') : selo('demo', 'alerta'))],
    ['Situação', (a) => {
      const [texto, classe] = SITUACAO[a.situacao] ?? [a.situacao, 'neutro'];
      return h('span', { title: a.erro ?? a.motivo ?? '' }, selo(texto, classe));
    }],
    ['Resultado', (a) => (a.lucro === null ? '—' : h('span', { class: Number(a.lucro) < 0 ? 'negativo' : 'positivo' }, fmt(a.lucro))), 'num mono'],
  ];
  return h('div', { class: 'tabela-caixa' }, h('table', { class: 'tabela' },
    h('thead', {}, h('tr', {}, colunas.map((c) => h('th', { class: c[2] ?? '' }, c[0])))),
    h('tbody', {}, apostas.map((a) => h('tr', {}, colunas.map((c) => h('td', { class: c[2] ?? '' }, c[1](a))))))));
}

export async function paginaBinarias({ recarregar }) {
  const dados = await api('GET', '/binarias');
  const novaConta = async () => {
    const r = await tentar(() => api('POST', '/binarias/contas', { nome: 'Quotex' }), 'Conta criada');
    if (r) {
      recarregar();
      janelaPonte(r);
    }
  };
  return [
    cabecalho('Binárias (Quotex)',
      'Opções binárias na sua conta da Quotex, pela ponte no seu computador. Simulação aqui é a conta demo da própria Quotex.',
      botao('Atualizar', { classe: 'secundario', nomeIcone: 'atualizar', onclick: () => recarregar() }),
      dados.contas.length ? botao('Nova estratégia', { nomeIcone: 'mais', onclick: () => abrirForm(null, dados, recarregar) }) : null),
    h('div', { class: 'destaque destaque-alerta' }, icone('alerta'), h('div', {},
      h('strong', {}, 'Por sua conta e risco'),
      h('p', {}, 'A Quotex não tem API oficial: a ponte entra na sua conta como se fosse o navegador, o que vai contra os termos dela, e ela pode bloquear a conta com o saldo dentro. A CVM já publicou alerta sobre a empresa que opera a Quotex. Na binária não existe stop: cada aposta perdida leva o valor inteiro, e com payout de 85% é preciso acertar mais de 54% só para empatar. Fique na demo até o acerto real passar disso com folga.'))),
    dados.contas.length
      ? h('div', { class: 'grade-cartoes' }, dados.contas.map((c) => cartaoConta(c, recarregar)))
      : vazio('Nenhuma conta Quotex', 'Crie a conta para receber o token da ponte. Ela começa na demo.', 'robo', botao('Criar conta Quotex', { nomeIcone: 'mais', onclick: novaConta })),
    dados.contas.length ? h('h2', {}, 'Estratégias') : null,
    dados.contas.length
      ? dados.estrategias.length
        ? h('div', { class: 'grade-cartoes' }, dados.estrategias.map((b) => cartaoEstrategia(b, dados, recarregar)))
        : vazio('Sem estratégias', 'Crie uma para o bot começar a apostar na demo.', 'estrategias')
      : null,
    h('h2', {}, 'Apostas'),
    dados.apostas.length ? tabelaApostas(dados.apostas) : vazio('Nenhuma aposta ainda', 'As apostas aparecem aqui assim que uma estratégia ativa vê um sinal com a ponte ligada.', 'ordens'),
  ];
}
