import {
  api, areaTexto, avisar, botao, botaoIcone, cabecalho, campo, confirmar, copiar, escalonar, escolha, fmt, h, icone,
  interruptor, janela, lerForm, precoCompacto, qtd, secao, selo, seloModo, tentar, vazio,
} from '../base.js';
import { barraUso } from '../graficos.js';

const MODOS_IA = { desligado: 'IA desligada', consultivo: 'IA consultiva', obrigatorio: 'IA obrigatória' };

function blocoWebhook(webhook) {
  return [
    h('div', { class: 'destaque destaque-alerta' }, icone('chave'), h('div', {}, h('strong', {}, 'Guarde esta URL agora'), h('p', {}, 'Ela é a senha da estratégia: quem tem a URL manda sinais. Ela não aparece de novo (no banco fica só o hash).'))),
    h('div', { class: 'copiavel' }, h('code', {}, webhook), botao('Copiar', { classe: 'pequeno', nomeIcone: 'copiar', onclick: () => copiar(webhook, 'URL copiada') })),
    h('h3', {}, 'Mensagem do alerta no TradingView'),
    h('pre', { class: 'codigo' }, '{"acao":"comprar","simbolo":"{{ticker}}","preco":{{close}},"id":"{{timenow}}"}'),
    h('pre', { class: 'codigo' }, '{"acao":"zerar","simbolo":"{{ticker}}","id":"{{timenow}}"}'),
    h('p', { class: 'suave' }, 'Ações: comprar (gasta o valor da ordem), vender (a "quantidade" informada ou tudo), zerar (vende tudo). "valor", "quantidade", "preco" e "id" são opcionais; o "id" evita executar o mesmo alerta duas vezes.'),
  ];
}

function formEstrategia({ e = {}, contas, ias, aoSalvar }) {
  const novo = !e.id;
  const escolhidas = new Set(e.ia_conectores ?? []);
  const listaIas = ias.length
    ? h('div', { class: 'opcoes-ia' }, ias.map((c) =>
        h('label', { class: `opcao-ia ${c.ativo ? '' : 'inativa'}` },
          h('input', { type: 'checkbox', 'data-ia': c.id, checked: escolhidas.has(c.id) }),
          h('span', {}, h('strong', {}, c.nome), h('small', { class: 'suave' }, c.modelo + (c.ativo ? '' : ' · desativado'))))))
    : h('p', { class: 'suave' }, 'Nenhum conector de IA cadastrado. Cadastre em IAs para usar aqui.');

  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        if (novo) d.conta_id = Number(d.conta_id);
        d.ips_permitidos = d.ips_permitidos ?? null;
        d.ia_contexto = d.ia_contexto ?? null;
        d.ia_quorum = d.ia_quorum || null;
        d.analise_validade_h = d.analise_validade_h || 24;
        d.ia_confianca_min = (d.ia_confianca_min ?? 60) / 100;
        d.ia_conectores = [...form.querySelectorAll('[data-ia]:checked')].map((el) => Number(el.dataset.ia));
        await aoSalvar(d);
      },
    },
    secao('Básico',
      novo ? escolha('Conta', 'conta_id', contas.map((c) => [c.id, `${c.nome} (${c.exchange}, ${c.modo === 'real' ? 'real' : 'simulação'})`]), contas[0]?.id) : null,
      campo('Nome', { name: 'nome', required: true, value: e.nome, placeholder: 'TradingView BTC' }),
      campo('Par (BASE/COTAÇÃO)', { name: 'simbolo', required: true, placeholder: 'BTC/USDT', value: e.simbolo }, 'No formato do CCXT: BTC/USDT, BTC/BRL'),
      novo ? interruptor('Ativar já', { name: 'ativa' }, 'Sem isto, os sinais são recusados até você ativar') : null,
    ),
    secao('Valores e limites',
      campo('Valor por ordem', { name: 'valor_ordem', type: 'number', step: 'any', min: '0', required: true, value: e.valor_ordem }, 'em moeda de cotação (USDT, BRL)'),
      campo('Limite por ordem', { name: 'limite_por_ordem', type: 'number', step: 'any', min: '0', required: true, value: e.limite_por_ordem }),
      campo('Limite de compras por dia', { name: 'limite_diario', type: 'number', step: 'any', min: '0', required: true, value: e.limite_diario }),
      campo('Limite da posição aberta', { name: 'limite_posicao', type: 'number', step: 'any', min: '0', value: e.limite_posicao }, 'opcional'),
    ),
    secao('Segurança',
      campo('Intervalo mínimo entre ordens (s)', { name: 'intervalo_min_seg', type: 'number', min: '0', value: e.intervalo_min_seg ?? 60 }),
      campo('Desvio máximo de preço (%)', { name: 'desvio_max_pct', type: 'number', step: '0.01', min: '0.01', value: e.desvio_max_pct ?? 1 }, 'preço do sinal x cotação atual'),
      campo('IPs permitidos', { name: 'ips_permitidos', value: e.ips_permitidos, placeholder: '52.89.214.238, 34.212.75.30, 54.218.53.128, 52.32.178.7' }, 'separados por vírgula; vazio = qualquer'),
    ),
    h('fieldset', { class: 'secao-form secao-ia' },
      h('legend', {}, icone('ias'), 'Parecer das IAs'),
      h('p', { class: 'suave' }, 'A IA só pode barrar uma ordem que as regras já aprovaram. Nunca cria ordem nem muda valor. "Zerar" nunca passa por ela.'),
      h('div', { class: 'campos' },
        escolha('Modo', 'ia_modo', [['desligado', 'Desligado'], ['consultivo', 'Consultivo (só registra)'], ['obrigatorio', 'Obrigatório (pode barrar)']], e.ia_modo ?? 'desligado'),
        campo('Aprovações necessárias', { name: 'ia_quorum', type: 'number', min: '1', max: '20', value: e.ia_quorum, placeholder: 'todas' }, 'vazio = todas as consultadas'),
        campo('Confiança mínima (%)', { name: 'ia_confianca_min', type: 'number', min: '0', max: '100', value: Math.round((e.ia_confianca_min ?? 0.6) * 100) }),
        escolha('Se uma IA falhar', 'ia_falha', [['reprova', 'Conta como não aprovou'], ['ignora', 'Ignora a que falhou']], e.ia_falha ?? 'reprova'),
      ),
      interruptor('Consultar também nas vendas', { name: 'ia_nas_vendas', checked: e.ia_nas_vendas }, 'Barrar venda pode prender uma posição perdendo'),
      h('div', { class: 'campo campo-largo' }, h('span', { class: 'campo-rotulo' }, 'Quais IAs (nenhuma marcada = todas as ativas)'), listaIas),
      areaTexto('O que a estratégia faz (vai para a IA)', { name: 'ia_contexto', rows: 3, value: e.ia_contexto ?? '', placeholder: 'Ex.: segue tendência no gráfico de 4h; compra no rompimento da média de 200; evita comprar depois de alta forte.' }),
    ),
    h('fieldset', { class: 'secao-form secao-ia' },
      h('legend', {}, icone('analise'), 'Nota da mesa de análise (5 agentes)'),
      h('p', { class: 'suave' }, 'Opcional: a estratégia só COMPRA se houver uma análise pronta e recente deste par com nota mínima. Vendas nunca dependem dela.'),
      h('div', { class: 'campos' },
        campo('Nota mínima para comprar (0 a 100)', { name: 'analise_nota_min', type: 'number', min: '0', max: '100', value: e.analise_nota_min, placeholder: 'não exige' }, 'vazio = não exige análise'),
        campo('Validade da análise (horas)', { name: 'analise_validade_h', type: 'number', min: '1', max: '720', value: e.analise_validade_h ?? 24 }),
      ),
    ),
    h('div', { class: 'acoes acoes-fim' }, h('button', { class: 'botao', type: 'submit' }, icone('ok'), h('span', {}, novo ? 'Criar estratégia' : 'Salvar'))),
  );
  return form;
}

function cartaoEstrategia(e, { resumo, ias, recarregar }) {
  const real = e.real && e.conta_modo === 'real' && resumo.real_no_servidor;
  const alterar = async (mudar, sucesso) => {
    if (await tentar(() => api('PATCH', `/estrategias/${e.id}`, mudar), sucesso)) recarregar();
  };
  return h(
    'article',
    { class: `cartao cartao-estrategia ${e.ativa ? '' : 'desligada'} ${real ? 'em-real' : ''}` },
    h('div', { class: 'cartao-estrategia-topo' },
      h('div', {}, h('span', { class: 'par' }, e.simbolo), h('h3', {}, e.nome), h('span', { class: 'suave' }, `${e.conta} · ${e.exchange} · token ${e.token_prefixo}…`)),
      h('label', { class: 'interruptor interruptor-so', title: e.ativa ? 'Desativar' : 'Ativar' },
        h('input', { type: 'checkbox', checked: e.ativa, onchange: (ev) => alterar({ ativa: ev.target.checked }, ev.target.checked ? 'Estratégia ativada' : 'Estratégia desativada') }),
        h('span', { class: 'interruptor-trilho' }, h('span', { class: 'interruptor-bola' }))),
    ),
    h('div', { class: 'fichas' },
      e.ativa ? selo('ativa', 'ok') : selo('parada', 'neutro'),
      seloModo(real ? 'real' : 'simulacao'),
      selo(MODOS_IA[e.ia_modo] ?? 'IA desligada', e.ia_modo === 'desligado' ? 'neutro' : 'ia', 'ias'),
      e.analise_nota_min !== null && e.analise_nota_min !== undefined ? selo(`nota ≥ ${e.analise_nota_min}`, 'ia', 'analise') : null,
    ),
    h('div', { class: 'numeros' },
      h('div', {}, h('span', { class: 'suave' }, 'Posição'), h('strong', { class: 'mono' }, qtd(e.posicao))),
      h('div', {}, h('span', { class: 'suave' }, 'Custo'), h('strong', { class: 'mono' }, fmt(e.custo_posicao))),
      h('div', {}, h('span', { class: 'suave' }, 'Por ordem'), h('strong', { class: 'mono' }, fmt(e.valor_ordem))),
    ),
    barraUso(Number(e.gasto_hoje ?? 0), Number(e.limite_diario), 'Compras hoje / limite diário'),
    h('div', { class: 'cartao-acoes' },
      botaoIcone('editar', 'Editar', { onclick: () => editar(e, ias, recarregar) }),
      botaoIcone('cotacao', 'Cotação agora', {
        onclick: async () => {
          const c = await tentar(() => api('GET', `/estrategias/${e.id}/cotacao`));
          if (c) avisar(`${c.simbolo}: ${precoCompacto(c.cotacao)}`, 'info');
        },
      }),
      botaoIcone('chave', 'Gerar novo token', {
        onclick: async () => {
          if (!(await confirmar('Gerar um token novo?', `A URL antiga de "${e.nome}" para de funcionar na hora e o alerta do TradingView precisa ser atualizado.`, { perigo: true, botao: 'Gerar token' }))) return;
          const r = await tentar(() => api('POST', `/estrategias/${e.id}/novo-token`));
          if (r) janela('Token novo', { icone: 'chave', largura: 'media' }, ...blocoWebhook(r.webhook));
        },
      }),
      h('span', { class: 'espaco' }),
      e.conta_modo === 'real'
        ? botao(e.real ? 'Voltar a simular' : 'Operar real', {
            classe: `pequeno ${e.real ? 'secundario' : 'perigo'}`,
            nomeIcone: e.real ? 'escudo' : 'energia',
            onclick: async () => {
              if (!e.real && !(await confirmar('Ligar dinheiro REAL?', `Cada sinal aceito em "${e.nome}" vira ordem de verdade na ${e.exchange}, dentro dos limites.`, { perigo: true, botao: 'Operar com dinheiro real' }))) return;
              alterar({ real: !e.real }, e.real ? 'Estratégia voltou para simulação' : 'Dinheiro real ligado nesta estratégia');
            },
          })
        : null,
    ),
  );
}

function editar(e, ias, recarregar) {
  const d = janela(`Editar ${e.nome}`, { icone: 'editar', largura: 'grande', subtitulo: `${e.simbolo} · ${e.conta}` },
    formEstrategia({
      e, contas: [], ias,
      aoSalvar: async (dados) => {
        if (await tentar(() => api('PATCH', `/estrategias/${e.id}`, dados), 'Estratégia atualizada')) {
          d.fechar();
          recarregar();
        }
      },
    }));
}

export async function paginaEstrategias({ recarregar }) {
  const [estrategias, contas, resumo, ias] = await Promise.all([api('GET', '/estrategias'), api('GET', '/contas'), api('GET', '/resumo'), api('GET', '/ias')]);
  const nova = () => {
    const d = janela('Nova estratégia', { icone: 'estrategias', largura: 'grande', subtitulo: 'Recebe sinais de uma fonte (TradingView ou outra) para um par numa conta' },
      formEstrategia({
        contas, ias,
        aoSalvar: async (dados) => {
          const r = await tentar(() => api('POST', '/estrategias', dados), 'Estratégia criada');
          if (r) {
            d.fechar();
            await recarregar();
            janela('Estratégia criada', { icone: 'ok', largura: 'media' }, ...blocoWebhook(r.webhook));
          }
        },
      }));
  };
  return [
    cabecalho('Estratégias', 'Cada estratégia recebe sinais por webhook e passa por regras de risco antes de virar ordem',
      botao('Nova estratégia', { nomeIcone: 'mais', disabled: !contas.length, onclick: nova })),
    !contas.length
      ? vazio('Crie uma conta primeiro', 'A estratégia precisa de uma conta (simulada ou real) numa exchange.', 'contas', h('a', { class: 'botao', href: '#/contas' }, 'Ir para Contas'))
      : estrategias.length
        ? h('div', { class: 'grade-cartoes' }, escalonar(estrategias.map((e) => cartaoEstrategia(e, { resumo, ias, recarregar }))))
        : vazio('Nenhuma estratégia', 'Crie a primeira e cole a URL do webhook no alerta do TradingView.', 'estrategias', botao('Nova estratégia', { nomeIcone: 'mais', onclick: nova })),
  ];
}
