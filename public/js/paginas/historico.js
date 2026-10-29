import { api, cabecalho, data, fmt, h, icone, pct, qtd, relativo, selo, seloLado, seloModo, seloSituacao, vazio } from '../base.js';

/** Barra de filtros: busca de texto e fichas de escolha única por grupo. */
function filtros(grupos, aoMudar) {
  const estado = Object.fromEntries(grupos.map((g) => [g.nome, '']));
  estado.texto = '';
  const busca = h('label', { class: 'busca' }, icone('busca'), h('input', {
    type: 'search', placeholder: 'Buscar…',
    oninput: (ev) => {
      estado.texto = ev.target.value.trim().toLowerCase();
      aoMudar(estado);
    },
  }));
  return h('div', { class: 'filtros' }, busca, grupos.map((g) =>
    h('div', { class: 'segmentado', role: 'group', 'aria-label': g.rotulo }, [['', 'Todos'], ...g.opcoes].map(([valor, texto]) =>
      h('button', {
        type: 'button', class: valor === '' ? 'escolhido' : '',
        onclick: (ev) => {
          estado[g.nome] = valor;
          for (const b of ev.currentTarget.parentElement.children) b.classList.toggle('escolhido', b === ev.currentTarget);
          aoMudar(estado);
        },
      }, texto)))));
}

function tabela(colunas, linhas, { aoClicar, detalhe } = {}) {
  const corpo = h('tbody');
  const desenhar = (lista) => {
    corpo.replaceChildren(...lista.flatMap((l) => {
      const tr = h('tr', { class: aoClicar || detalhe ? 'clicavel' : '' }, colunas.map((c) => h('td', { class: c[2] ?? '' }, c[1](l))));
      if (!detalhe) return [tr];
      const extra = h('tr', { class: 'linha-detalhe', hidden: true }, h('td', { colspan: colunas.length }, detalhe(l)));
      tr.addEventListener('click', () => {
        extra.hidden = !extra.hidden;
        tr.classList.toggle('aberta', !extra.hidden);
      });
      return [tr, extra];
    }));
    if (!lista.length) corpo.replaceChildren(h('tr', {}, h('td', { colspan: colunas.length, class: 'tabela-vazia' }, 'Nada com esse filtro.')));
  };
  desenhar(linhas);
  const el = h('div', { class: 'tabela-caixa' }, h('table', { class: 'tabela' }, h('thead', {}, h('tr', {}, colunas.map((c) => h('th', { class: c[2] ?? '' }, c[0])))), corpo));
  return { el, desenhar };
}

function pareceres(lista) {
  if (!lista?.length) return null;
  return h('div', { class: 'pareceres' }, h('h4', {}, icone('ias'), 'Parecer das IAs'), h('div', { class: 'pareceres-lista' }, lista.map((p) =>
    h('div', { class: `parecer parecer-${p.decisao ?? 'falha'}` },
      h('div', { class: 'parecer-topo' },
        h('strong', {}, p.conector),
        p.decisao ? selo(p.decisao === 'aprovar' ? 'aprovou' : 'vetou', p.decisao === 'aprovar' ? 'ok' : 'perigo') : selo('falhou', 'perigo', 'alerta'),
        h('span', { class: 'mono suave' }, `${p.confianca !== null ? pct(p.confianca) + ' · ' : ''}${(p.ms / 1000).toFixed(1)} s`)),
      h('span', { class: 'suave mono pequeno-texto' }, p.modelo),
      h('p', {}, p.motivo ?? p.erro ?? '')))));
}

export async function paginaSinais() {
  const sinais = await api('GET', '/sinais?limite=300');
  const colunas = [
    ['Quando', (x) => h('div', {}, h('span', {}, relativo(x.recebido_em)), h('small', { class: 'suave bloco' }, data(x.recebido_em)))],
    ['Estratégia', (x) => x.estrategia ?? '—'],
    ['Ação', (x) => (x.acao ? h('span', { class: `acao acao-${x.acao}` }, x.acao) : '—')],
    ['Situação', (x) => h('div', { class: 'fichas' }, seloSituacao(x.situacao), x.pareceres?.length ? selo(`${x.pareceres.length} IA`, 'ia', 'ias') : null)],
    ['Motivo', (x) => h('span', { class: 'motivo' }, x.motivo ?? '')],
    ['IP', (x) => h('span', { class: 'mono suave' }, x.ip ?? ''), 'some-celular'],
  ];
  const t = tabela(colunas, sinais, {
    detalhe: (x) => h('div', { class: 'detalhe' }, h('h4', {}, 'Corpo recebido'), h('pre', { class: 'codigo' }, JSON.stringify(x.corpo, null, 2)), pareceres(x.pareceres)),
  });
  const aplicar = (f) =>
    t.desenhar(sinais.filter((x) => (!f.situacao || x.situacao === f.situacao) && (!f.texto || JSON.stringify([x.estrategia, x.acao, x.motivo, x.ip, x.corpo]).toLowerCase().includes(f.texto))));
  return [
    cabecalho('Sinais recebidos', 'Todo sinal fica registrado, aceito ou não, com o motivo. Clique numa linha para ver o corpo e o parecer das IAs.'),
    sinais.length
      ? h('div', { class: 'cartao cartao-tabela' },
          filtros([{ nome: 'situacao', rotulo: 'Situação', opcoes: [['executado', 'Executados'], ['rejeitado', 'Rejeitados'], ['ignorado', 'Ignorados'], ['erro', 'Erro']] }], aplicar),
          t.el)
      : vazio('Nenhum sinal recebido ainda', 'Quando o TradingView (ou outra fonte) mandar o primeiro alerta, ele aparece aqui.', 'sinais'),
  ];
}

export async function paginaOrdens() {
  const ordens = await api('GET', '/ordens?limite=300');
  const colunas = [
    ['Quando', (o) => h('div', {}, h('span', {}, relativo(o.criada_em)), h('small', { class: 'suave bloco' }, data(o.criada_em)))],
    ['Estratégia', (o) => o.estrategia],
    ['Lado', (o) => seloLado(o.lado)],
    ['Par', (o) => h('strong', {}, o.simbolo)],
    ['Quantidade', (o) => h('span', { class: 'mono' }, qtd(o.quantidade)), 'num'],
    ['Preço médio', (o) => h('span', { class: 'mono' }, fmt(o.preco_medio, 8)), 'num'],
    ['Total', (o) => h('span', { class: 'mono' }, fmt(o.custo)), 'num'],
    ['Modo', (o) => seloModo(o.modo)],
    ['Situação', (o) => h('div', {}, seloSituacao(o.situacao), o.erro ? h('small', { class: 'perigo-txt bloco' }, o.erro) : null)],
  ];
  const totais = h('div', { class: 'totais' });
  const resumir = (lista) => {
    const ok = lista.filter((o) => o.situacao === 'executada');
    const soma = (lado) => ok.filter((o) => o.lado === lado).reduce((t, o) => t + Number(o.custo), 0);
    totais.replaceChildren(
      h('div', {}, h('span', { class: 'suave' }, 'Ordens'), h('strong', {}, String(lista.length))),
      h('div', {}, h('span', { class: 'suave' }, 'Compras'), h('strong', { class: 'mono' }, fmt(soma('compra')))),
      h('div', {}, h('span', { class: 'suave' }, 'Vendas'), h('strong', { class: 'mono' }, fmt(soma('venda')))),
      h('div', {}, h('span', { class: 'suave' }, 'Taxas'), h('strong', { class: 'mono' }, fmt(ok.reduce((t, o) => t + Number(o.taxa), 0), 6))),
    );
  };
  resumir(ordens);
  const t = tabela(colunas, ordens, { detalhe: (o) => h('div', { class: 'detalhe' }, h('p', {}, 'Id na exchange: ', h('code', {}, o.id_exchange ?? '—')), h('p', {}, 'Taxa: ', h('span', { class: 'mono' }, fmt(o.taxa, 8)))) });
  const aplicar = (f) => {
    const lista = ordens.filter((o) => (!f.modo || o.modo === f.modo) && (!f.lado || o.lado === f.lado) && (!f.texto || `${o.estrategia} ${o.simbolo} ${o.erro ?? ''}`.toLowerCase().includes(f.texto)));
    t.desenhar(lista);
    resumir(lista);
  };
  return [
    cabecalho('Ordens', 'Ordens enviadas para a exchange (ou simuladas), com preço médio, total e taxa'),
    ordens.length
      ? h('div', { class: 'cartao cartao-tabela' },
          filtros([
            { nome: 'lado', rotulo: 'Lado', opcoes: [['compra', 'Compras'], ['venda', 'Vendas']] },
            { nome: 'modo', rotulo: 'Modo', opcoes: [['simulacao', 'Simulação'], ['real', 'Real']] },
          ], aplicar),
          totais,
          t.el)
      : vazio('Nenhuma ordem ainda', 'Assim que um sinal passar pelas regras, a ordem aparece aqui.', 'ordens'),
  ];
}

const TIPOS = {
  login: ['usuario', 'Entrou no painel'],
  parada_ligada: ['energia', 'Ligou a parada geral'],
  parada_desligada: ['testar', 'Desligou a parada geral'],
  conta_criada: ['contas', 'Criou uma conta'],
  conta_alterada: ['contas', 'Alterou uma conta'],
  saldo_simulado: ['contas', 'Definiu saldo simulado'],
  estrategia_criada: ['estrategias', 'Criou uma estratégia'],
  estrategia_alterada: ['estrategias', 'Alterou uma estratégia'],
  token_trocado: ['chave', 'Trocou o token de uma estratégia'],
  ia_criada: ['ias', 'Adicionou um conector de IA'],
  ia_alterada: ['ias', 'Alterou um conector de IA'],
  ia_apagada: ['ias', 'Apagou um conector de IA'],
  ia_pergunta: ['ias', 'Perguntou às IAs'],
  analise_pedida: ['analise', 'Pediu uma análise de 5 agentes'],
};

export async function paginaAuditoria() {
  const eventos = await api('GET', '/eventos');
  return [
    cabecalho('Auditoria', 'Quem mudou o quê no painel: parada geral, modo real, chaves, limites e IAs'),
    eventos.length
      ? h('div', { class: 'cartao' }, h('ol', { class: 'linha-do-tempo' }, eventos.map((e) => {
          const [ic, texto] = TIPOS[e.tipo] ?? ['auditoria', e.tipo];
          const sensivel = /parada|real|token|chave/.test(e.tipo) || e.detalhe?.modo_depois === 'real' || e.detalhe?.chaves_trocadas || e.detalhe?.chave_trocada;
          return h('li', { class: `evento ${sensivel ? 'evento-sensivel' : ''}` },
            h('span', { class: 'evento-icone' }, icone(ic)),
            h('div', { class: 'evento-corpo' },
              h('div', { class: 'evento-topo' }, h('strong', {}, texto), h('span', { class: 'suave' }, `${e.email ?? 'sistema'} · ${relativo(e.criado_em)}`)),
              Object.keys(e.detalhe ?? {}).length ? h('code', { class: 'evento-detalhe' }, JSON.stringify(e.detalhe)) : null,
              h('small', { class: 'suave' }, data(e.criado_em))));
        })))
      : vazio('Nada registrado ainda', null, 'auditoria'),
  ];
}
