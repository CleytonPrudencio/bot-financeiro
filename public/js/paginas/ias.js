import {
  api, areaTexto, botao, botaoIcone, cabecalho, campo, confirmar, escalonar, escolha, h, icone, interruptor, janela,
  lerForm, pct, reduzido, relativo, secao, selo, tentar, vazio,
} from '../base.js';

// Cada conector é um modelo de um provedor. O Claude vai pelo SDK oficial da Anthropic; os
// outros, por qualquer API no formato da OpenAI (só muda a URL base, o modelo e a chave).

const IDENTIDADE = [
  { teste: (c) => c.provedor === 'anthropic', nome: 'Claude', cor: '#d97757', sigla: 'C' },
  { teste: (c) => /openai\.com/.test(c.url_base ?? ''), nome: 'OpenAI', cor: '#10a37f', sigla: 'AI' },
  { teste: (c) => /googleapis\.com/.test(c.url_base ?? ''), nome: 'Gemini', cor: '#4285f4', sigla: 'G' },
  { teste: (c) => /openrouter\.ai/.test(c.url_base ?? ''), nome: 'OpenRouter', cor: '#6366f1', sigla: 'OR' },
  { teste: (c) => /groq\.com/.test(c.url_base ?? ''), nome: 'Groq', cor: '#f55036', sigla: 'GQ' },
  { teste: (c) => /deepseek\.com/.test(c.url_base ?? ''), nome: 'DeepSeek', cor: '#4d6bfe', sigla: 'DS' },
  { teste: (c) => /mistral\.ai/.test(c.url_base ?? ''), nome: 'Mistral', cor: '#fa520f', sigla: 'M' },
  { teste: (c) => /x\.ai/.test(c.url_base ?? ''), nome: 'xAI', cor: '#94a3b8', sigla: 'X' },
  { teste: (c) => /ollama/.test(c.url_base ?? ''), nome: 'Ollama', cor: '#a3a3a3', sigla: 'OL' },
];
const identidade = (c) => IDENTIDADE.find((i) => i.teste(c)) ?? { nome: 'Compatível', cor: '#a78bfa', sigla: 'IA' };

function marcaProvedor(c, grande = false) {
  const i = identidade(c);
  return h('span', { class: `prov ${grande ? 'prov-grande' : ''}`, estilo: { '--cor': i.cor }, title: i.nome }, i.sigla);
}

const ESFORCOS = [['low', 'Baixo (mais rápido e barato)'], ['medium', 'Médio'], ['high', 'Alto (mais lento)']];

function formConector({ c = null, opcoes, aoSalvar }) {
  const novo = !c;
  let provedor = c?.provedor ?? 'anthropic';
  let preset = c ? null : 'claude';
  const area = h('div');

  const tiles = novo
    ? h('div', { class: 'tiles' }, [
        { id: 'claude', nome: 'Claude (Anthropic)', provedor: 'anthropic', cor: '#d97757', sigla: 'C' },
        ...opcoes.compativeis.map((p) => {
          const i = identidade({ provedor: 'openai', url_base: p.url_base });
          return { ...p, provedor: 'openai', cor: i.cor, sigla: i.sigla };
        }),
      ].map((p) =>
        h('button', {
          type: 'button',
          class: `tile ${p.id === preset ? 'escolhido' : ''}`,
          estilo: { '--cor': p.cor },
          onclick: (ev) => {
            preset = p.id;
            provedor = p.provedor;
            for (const t of tiles.children) t.classList.toggle('escolhido', t === ev.currentTarget);
            montar(p);
          },
        }, h('span', { class: 'prov' }, p.sigla), h('span', {}, p.nome))))
    : null;

  function montar(p) {
    const ehClaude = provedor === 'anthropic';
    const modelos = opcoes.claude;
    area.replaceChildren(
      secao('Conector',
        campo('Nome', { name: 'nome', required: true, value: c?.nome ?? (ehClaude ? 'Claude' : p?.nome?.split(' (')[0] ?? ''), placeholder: 'Analista conservador' }),
        ehClaude
          ? escolha('Modelo', 'modelo', modelos.map((m) => [m.id, m.nome]), c?.modelo ?? 'claude-opus-5-5')
          : campo('Modelo', { name: 'modelo', required: true, value: c?.modelo ?? p?.modelo ?? '', placeholder: 'nome do modelo no provedor' }, 'exatamente como o provedor chama'),
        ehClaude ? null : campo('URL base da API', { name: 'url_base', required: true, value: c?.url_base ?? p?.url_base ?? '', placeholder: 'https://…/v1' }, 'https, ou http só para endereço interno'),
        campo(ehClaude ? 'Chave de API da Anthropic' : 'Chave de API', {
          name: 'api_key', type: 'password', autocomplete: 'off', required: novo && (ehClaude || p?.precisa_chave),
          placeholder: c?.tem_chave ? 'vazio = mantém a atual' : ehClaude ? 'sk-ant-…' : p?.precisa_chave === false ? 'não precisa' : '',
        }, 'fica cifrada e nunca volta para a tela'),
      ),
      secao('Comportamento',
        ehClaude ? escolha('Esforço de raciocínio', 'esforco', ESFORCOS, c?.esforco ?? 'low') : null,
        campo('Tempo máximo (s)', { name: 'timeout_seg', type: 'number', min: '3', max: '120', value: c?.timeout_seg ?? 25 }, 'passou disso, conta como falha'),
      ),
      areaTexto('Orientação extra para esta IA (opcional)', { name: 'instrucoes', rows: 3, value: c?.instrucoes ?? '', placeholder: 'Ex.: seja conservador; vete compras depois de alta de mais de 5% no dia.' }),
      interruptor('Ativo', { name: 'ativo', checked: c?.ativo ?? true }),
      !novo && c?.tem_chave ? interruptor('Apagar a chave cadastrada', { name: 'apagar_chave' }) : null,
      ehClaude
        ? h('p', { class: 'suave pequeno-texto' }, icone('escudo'), 'Se o modelo recusar por política, a API refaz o pedido no modelo reserva recomendado pela Anthropic, na mesma chamada.')
        : null,
    );
  }
  montar(c ? null : { nome: 'Claude' });

  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const d = lerForm(form);
        if (novo) d.provedor = provedor;
        if (!d.apagar_chave) delete d.apagar_chave;
        d.instrucoes = d.instrucoes ?? null;
        await aoSalvar(d);
      },
    },
    novo ? h('div', { class: 'campo campo-largo' }, h('span', { class: 'campo-rotulo' }, 'Provedor'), tiles) : null,
    area,
    h('div', { class: 'acoes acoes-fim' }, h('button', { class: 'botao', type: 'submit' }, icone('ok'), h('span', {}, novo ? 'Adicionar conector' : 'Salvar'))),
  );
  return form;
}

function resultadoParecer(r) {
  return r.ok
    ? h('div', { class: `parecer parecer-${r.parecer.decisao}` },
        h('div', { class: 'parecer-topo' }, selo(r.parecer.decisao === 'aprovar' ? 'aprovaria' : 'vetaria', r.parecer.decisao === 'aprovar' ? 'ok' : 'perigo'), h('span', { class: 'mono suave' }, `${pct(r.parecer.confianca)} · ${(r.ms / 1000).toFixed(1)} s`)),
        h('p', {}, r.parecer.motivo))
    : h('div', { class: 'parecer parecer-falha' }, h('div', { class: 'parecer-topo' }, selo('falhou', 'perigo', 'alerta'), h('span', { class: 'mono suave' }, `${(r.ms / 1000).toFixed(1)} s`)), h('p', {}, r.erro));
}

function cartaoConector(c, { opcoes, recarregar }) {
  const i = identidade(c);
  const teste = c.ultimo_teste;
  const saida = h('div', { class: 'cartao-ia-saida' });
  const botaoTestar = botao('Testar', {
    classe: 'pequeno secundario',
    nomeIcone: 'testar',
    onclick: async () => {
      botaoTestar.disabled = true;
      botaoTestar.classList.add('carregando');
      saida.replaceChildren(h('div', { class: 'esqueleto esqueleto-texto' }), h('div', { class: 'esqueleto esqueleto-texto curto' }));
      const r = await tentar(() => api('POST', `/ias/${c.id}/testar`));
      botaoTestar.disabled = false;
      botaoTestar.classList.remove('carregando');
      saida.replaceChildren(r ? resultadoParecer(r) : h('span'));
    },
  });
  return h(
    'article',
    { class: `cartao cartao-ia ${c.ativo ? '' : 'desligada'}`, estilo: { '--cor': i.cor } },
    h('div', { class: 'cartao-ia-topo' },
      marcaProvedor(c, true),
      h('div', { class: 'cartao-ia-nome' }, h('h3', {}, c.nome), h('span', { class: 'suave mono' }, c.modelo)),
      h('label', { class: 'interruptor interruptor-so', title: c.ativo ? 'Desativar' : 'Ativar' },
        h('input', { type: 'checkbox', checked: c.ativo, onchange: async (ev) => { if (await tentar(() => api('PATCH', `/ias/${c.id}`, { ativo: ev.target.checked }), ev.target.checked ? 'Conector ativado' : 'Conector desativado')) recarregar(); } }),
        h('span', { class: 'interruptor-trilho' }, h('span', { class: 'interruptor-bola' }))),
    ),
    h('div', { class: 'fichas' },
      selo(i.nome, 'neutro'),
      c.provedor === 'anthropic' ? selo(`esforço ${({ low: 'baixo', medium: 'médio', high: 'alto' })[c.esforco]}`, 'neutro') : null,
      selo(`até ${c.timeout_seg} s`, 'neutro', 'relogio'),
      c.tem_chave ? selo('chave', 'ok', 'chave') : selo('sem chave', 'neutro'),
    ),
    h('div', { class: 'cartao-ia-teste' },
      teste
        ? h('span', { class: teste.ok ? 'ok-txt' : 'perigo-txt' }, icone(teste.ok ? 'ok' : 'alerta'), teste.ok ? `respondeu em ${(teste.ms / 1000).toFixed(1)} s` : teste.erro, h('span', { class: 'suave' }, ` · ${relativo(teste.em)}`))
        : h('span', { class: 'suave' }, 'ainda não testado'),
    ),
    saida,
    h('div', { class: 'cartao-acoes' },
      botaoTestar,
      h('span', { class: 'espaco' }),
      botaoIcone('editar', 'Editar', {
        onclick: () => {
          const d = janela(`Editar ${c.nome}`, { icone: 'ias', largura: 'grande', subtitulo: `${i.nome} · ${c.modelo}` },
            formConector({ c, opcoes, aoSalvar: async (dados) => { if (await tentar(() => api('PATCH', `/ias/${c.id}`, dados), 'Conector atualizado')) { d.fechar(); recarregar(); } } }));
        },
      }),
      botaoIcone('apagar', 'Apagar', {
        class: 'perigo-hover',
        onclick: async () => {
          if (!(await confirmar(`Apagar ${c.nome}?`, 'As estratégias que usam este conector deixam de consultá-lo. Os pareceres antigos ficam no histórico.', { perigo: true, botao: 'Apagar' }))) return;
          if (await tentar(() => api('DELETE', `/ias/${c.id}`), 'Conector apagado')) recarregar();
        },
      }),
    ),
  );
}

/** Revela o texto aos poucos, como se a IA estivesse digitando. */
function digitar(el, texto) {
  if (reduzido()) {
    el.textContent = texto;
    return;
  }
  let i = 0;
  const passo = Math.max(2, Math.round(texto.length / 120));
  const tick = () => {
    i = Math.min(texto.length, i + passo);
    el.textContent = texto.slice(0, i);
    if (i < texto.length && el.isConnected) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function consolePerguntar(ativos) {
  const escolhidos = new Set(ativos.map((c) => c.id));
  const respostas = h('div', { class: 'respostas' });
  const pergunta = h('textarea', { rows: 3, maxlength: 4000, placeholder: 'Ex.: o que você observaria antes de comprar BTC depois de uma alta de 8% na semana?' });
  const enviar = botao('Perguntar a todas', { nomeIcone: 'enviar' });
  const chips = h('div', { class: 'fichas' }, ativos.map((c) =>
    h('button', {
      type: 'button', class: 'chip escolhido', estilo: { '--cor': identidade(c).cor },
      onclick: (ev) => {
        if (escolhidos.has(c.id)) escolhidos.delete(c.id);
        else escolhidos.add(c.id);
        ev.currentTarget.classList.toggle('escolhido', escolhidos.has(c.id));
      },
    }, marcaProvedor(c), c.nome)));

  const perguntar = async () => {
    const texto = pergunta.value.trim();
    if (texto.length < 2 || !escolhidos.size) return;
    const lista = ativos.filter((c) => escolhidos.has(c.id));
    enviar.disabled = true;
    enviar.classList.add('carregando');
    respostas.replaceChildren(...escalonar(lista.map((c) =>
      h('div', { class: 'resposta pensando', 'data-id': c.id, estilo: { '--cor': identidade(c).cor } },
        h('div', { class: 'resposta-topo' }, marcaProvedor(c), h('strong', {}, c.nome), h('span', { class: 'pontinhos' }, h('i'), h('i'), h('i'))),
        h('div', { class: 'esqueleto esqueleto-texto' }), h('div', { class: 'esqueleto esqueleto-texto' }), h('div', { class: 'esqueleto esqueleto-texto curto' })))));
    const r = await tentar(() => api('POST', '/ias/perguntar', { pergunta: texto, conectores: lista.map((c) => c.id) }));
    enviar.disabled = false;
    enviar.classList.remove('carregando');
    if (!r) return respostas.replaceChildren();
    for (const resp of r) {
      const caixa = respostas.querySelector(`[data-id="${resp.conector_id}"]`);
      if (!caixa) continue;
      const c = ativos.find((x) => x.id === resp.conector_id);
      const corpo = h('div', { class: 'resposta-texto' });
      caixa.classList.remove('pensando');
      caixa.replaceChildren(
        h('div', { class: 'resposta-topo' }, marcaProvedor(c), h('strong', {}, resp.conector), h('span', { class: 'mono suave' }, `${(resp.ms / 1000).toFixed(1)} s`)),
        h('span', { class: 'suave mono pequeno-texto' }, resp.modelo),
        resp.ok ? corpo : h('p', { class: 'perigo-txt' }, icone('alerta'), resp.erro),
      );
      if (resp.ok) digitar(corpo, resp.texto);
    }
  };
  enviar.addEventListener('click', perguntar);
  pergunta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) perguntar();
  });

  return h('section', { class: 'cartao console-ia' },
    h('div', { class: 'cartao-topo' }, h('div', {}, h('h2', {}, icone('ias'), 'Perguntar a todas'), h('p', { class: 'suave' }, 'A mesma pergunta vai para as IAs escolhidas ao mesmo tempo. Cada resposta custa na conta do provedor.'))),
    chips,
    h('div', { class: 'console-entrada' }, pergunta, enviar),
    h('small', { class: 'suave' }, 'Ctrl+Enter envia'),
    respostas,
  );
}

export async function paginaIas({ recarregar }) {
  const [ias, opcoes] = await Promise.all([api('GET', '/ias'), api('GET', '/ias/opcoes')]);
  const ativos = ias.filter((c) => c.ativo);
  const novo = () => {
    const d = janela('Novo conector de IA', { icone: 'ias', largura: 'grande', subtitulo: 'Claude pelo SDK oficial ou qualquer API compatível com a da OpenAI' },
      formConector({ opcoes, aoSalvar: async (dados) => { if (await tentar(() => api('POST', '/ias', dados), 'Conector adicionado')) { d.fechar(); recarregar(); } } }));
  };
  return [
    cabecalho('IAs', 'Conecte quantas IAs quiser para dar parecer nas ordens dos robôs e responder perguntas', botao('Novo conector', { nomeIcone: 'mais', onclick: novo })),
    h('div', { class: 'destaque destaque-ia' }, icone('escudo'),
      h('div', {}, h('strong', {}, 'A IA só pode barrar, nunca mandar'),
        h('p', {}, 'O parecer roda depois das regras de risco. A IA não cria ordem, não muda valor e não passa por cima de limite. "Zerar" nunca passa por ela. Em cada estratégia você escolhe: desligado, consultivo (só registra) ou obrigatório (pode barrar).'))),
    ias.length
      ? h('div', { class: 'grade-cartoes' }, escalonar(ias.map((c) => cartaoConector(c, { opcoes, recarregar }))))
      : vazio('Nenhuma IA conectada', 'Adicione o Claude, o ChatGPT, o Gemini, o Ollama da VM ou qualquer API compatível.', 'ias', botao('Novo conector', { nomeIcone: 'mais', onclick: novo })),
    ativos.length ? consolePerguntar(ativos) : null,
  ];
}
