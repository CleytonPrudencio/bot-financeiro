import {
  agora, api, botao, botaoSegurar, cabecalho, campo, confirmar, contar, data, escalonar, fmt, h, icone, inteiro, janela, lerForm, precoCompacto,
  FUSO, qtd, relativo, selo, seloLado, seloModo, tentar, vazio,
} from '../base.js';
import { graficoArea, graficoResultado, graficoSaldo, linhaPequena, rosca } from '../graficos.js';

function saudacao() {
  const hora = Number(new Date(agora()).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: FUSO }));
  return hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
}

/** Anima um número de `de` até `para` (o painel ao vivo muda os KPIs sem recarregar). */
function animarPara(el, de, para, formato) {
  if (de === para) return;
  const inicio = performance.now();
  const passo = (t) => {
    const k = Math.min(1, (t - inicio) / 700);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = formato(de + (para - de) * e);
    if (k < 1 && el.isConnected) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
  el.classList.remove('kpi-mudou');
  void el.offsetWidth; // reinicia a animação de destaque
  el.classList.add('kpi-mudou');
}

function kpi(rotulo, valor, { nomeIcone, formato = (v) => fmt(v), serie, cor, nota, classe = '', vivos, chave }) {
  const numero = h('div', { class: 'kpi-valor' }, '0');
  contar(numero, valor, formato);
  if (vivos && chave) vivos.set(chave, { numero, valor: Number(valor) || 0, formato });
  return h(
    'div',
    { class: `cartao kpi ${classe}` },
    h('div', { class: 'kpi-topo' }, h('span', { class: 'kpi-icone' }, icone(nomeIcone)), h('span', { class: 'kpi-rotulo' }, rotulo)),
    numero,
    h('div', { class: 'kpi-pe' }, nota ? h('span', { class: 'suave' }, nota) : h('span'), serie ? linhaPequena(serie, cor) : null),
  );
}

function cartaoParada(r, recarregar) {
  const ligada = r.parada_geral;
  const acao = ligada
    ? h(
        'button',
        {
          class: 'botao',
          onclick: async () => {
            if (!(await confirmar('Desligar a parada geral?', 'As estratégias ativas voltam a operar a partir do próximo sinal.', { botao: 'Voltar a operar' }))) return;
            if (await tentar(() => api('POST', '/parada', { ligada: false }), 'Parada desligada: o robô voltou a operar')) recarregar();
          },
        },
        icone('testar'),
        h('span', {}, 'Voltar a operar'),
      )
    : botaoSegurar('Segure para PARAR TUDO', {
        aoConfirmar: async () => {
          if (await tentar(() => api('POST', '/parada', { ligada: true }), 'Parada geral ligada: nenhuma ordem sai')) recarregar();
        },
      });
  return h(
    'div',
    { class: `cartao parada ${ligada ? 'parada-ligada' : ''}` },
    h('div', { class: 'parada-estado' }, h('span', { class: 'parada-luz' }), h('div', {},
      h('strong', {}, ligada ? 'Parada geral LIGADA' : 'Robô operando'),
      h('p', { class: 'suave' }, ligada ? 'Nenhum sinal vira ordem, de nenhuma estratégia, até você desligar.' : 'A parada geral bloqueia todas as ordens na hora, inclusive vendas.'),
    )),
    acao,
  );
}

// grupos que explicam a falta de compra (os outros são normais: desligada, com posição, comprou)
const GRUPOS_ATENCAO = new Set(['sem_saldo', 'ia_vetou', 'ia_falhou', 'limite_ia', 'risco_barrou', 'erro_ordem', 'erro_piloto', 'acao_cara', 'aviso']);
const DICAS = {
  sem_saldo: 'Confira o saldo na exchange ou na corretora. No MetaTrader que mostra o saldo, o "saldo livre" é o que conta (o SwingTrade da Genial mostra 0,00 e o bot manda a ordem mesmo assim).',
  ia_vetou: 'O agente achou a entrada arriscada. Em Agente ou na estratégia dá para ajustar o rigor (ou deixar a IA consultiva).',
  ia_falhou: 'Abra a página IAs e clique em Testar em cada uma: o erro diz se é crédito acabando, limite de uso ou chave errada. Sem resposta da IA, a compra não sai (falha conta como não aprovou).',
  limite_ia: 'Cada estratégia consulta a IA poucas vezes por dia para não gastar crédito; aumente em "consultas à IA por dia".',
  risco_barrou: 'Um limite da estratégia (intervalo, limite diário, posição) segurou a ordem.',
  erro_ordem: 'A exchange ou a ponte recusou a ordem: veja o motivo em Sinais.',
  erro_piloto: 'O piloto não conseguiu cotação ou velas (a ponte MT5 está aberta?).',
  acao_cara: 'Na B3 só se compra ação inteira: aumente o valor por ordem ou deixe para as ações mais baratas.',
  sem_sinal: 'É o normal com o mercado sem oportunidade: o piloto espera a entrada certa.',
  bolsa_fechada: 'A B3 funciona em dias úteis, das 10h às 16h55.',
};

/** "Por que não está comprando?": a última passada de cada estratégia, em grupos. */
function cartaoDiagnostico(d) {
  const total = d.grupos.reduce((t, g) => t + g.n, 0);
  const sinais = d.sinais_hoje ?? {};
  const linhas = d.grupos.map((g) => {
    const atencao = GRUPOS_ATENCAO.has(g.grupo);
    const detalhe = h('div', { class: 'diag-detalhe', hidden: true },
      DICAS[g.grupo] ? h('p', { class: 'suave' }, DICAS[g.grupo]) : null,
      h('ul', {}, g.exemplos.map((x) => h('li', {}, h('strong', {}, x.nome), x.situacao ? `: ${x.situacao}` : ''))));
    const linha = h('button', { class: `diag-linha ${atencao ? 'atencao' : ''}`, type: 'button', onclick: () => (detalhe.hidden = !detalhe.hidden) },
      h('span', { class: 'diag-n mono' }, inteiro(g.n)),
      h('span', { class: 'diag-rotulo' }, g.rotulo),
      h('span', { class: 'diag-barra' }, h('i', { estilo: { width: `${Math.round((g.n / Math.max(1, total)) * 100)}%` } })));
    return h('div', {}, linha, detalhe);
  });
  return h('div', { class: 'cartao diag' },
    h('div', { class: 'cartao-topo' },
      h('div', {}, h('h2', {}, 'Por que não está comprando?'), h('p', { class: 'suave' }, `O que cada uma das ${total} estratégias viu na última passada do piloto. Toque numa linha para ver exemplos.`)),
      h('a', { class: 'link', href: '#/sinais' }, 'Sinais ', icone('seta'))),
    h('div', { class: 'diag-lista' }, linhas),
    h('div', { class: 'fichas diag-fichas' },
      h('span', { class: 'ficha' }, `Hoje: ${inteiro(sinais.executado ?? 0)} executados · ${inteiro(sinais.rejeitado ?? 0)} rejeitados · ${inteiro(sinais.ignorado ?? 0)} ignorados · ${inteiro(sinais.erro ?? 0)} com erro`),
      h('span', { class: `ficha ${d.real_no_servidor ? 'ficha-perigo' : ''}` }, d.real_no_servidor ? `${d.estrategias.em_real} estratégia(s) no real` : 'dinheiro real desligado no servidor'),
      ...d.pontes_mt5.map((p) => h('span', { class: `ficha ${p.online ? '' : 'ficha-alerta'}` }, `${p.nome}: ponte ${p.online ? 'ligada' : 'parada'}${p.saldo_livre === null ? '' : Number(p.saldo_livre) > 0 ? ` · saldo livre ${fmt(p.saldo_livre)}` : ' · o MetaTrader não mostra o saldo: a corretora confere na ordem'}`))),
    ...d.pontes_mt5.filter((p) => p.divergencias?.length).map((p) => h('div', { class: 'destaque destaque-alerta diag-divergencia' }, icone('alerta'), h('div', {},
      h('strong', {}, `${p.nome}: o MetaTrader e o bot não batem`),
      h('ul', {}, p.divergencias.map((x) => h('li', {}, `${x.codigo}: ${x.no_mt5} ação(ões) no MetaTrader, ${x.no_bot} no bot`))),
      h('p', { class: 'suave' }, 'Uma ordem pode ter saído sem o bot saber (ou o contrário). Confira na aba Negociação do MetaTrader: se a ação está lá e o bot não sabe, ela fica sem stop; venda pelo MetaTrader ou me avise para conciliar.')))),
    d.motivos_hoje.length
      ? h('div', { class: 'diag-motivos' }, h('h3', {}, 'Motivos mais comuns hoje'),
          h('ol', {}, d.motivos_hoje.map((m) => h('li', {}, h('span', { class: 'mono' }, `${inteiro(m.n)}×`), ' ', selo(m.situacao, m.situacao === 'erro' ? 'perigo' : 'alerta'), ' ', m.motivo))))
      : null);
}

const sinalDe = (v) => `${v > 0 ? '+' : ''}${fmt(v)}`;
const classeDe = (v) => (v > 0 ? 'positivo' : v < 0 ? 'negativo' : '');
const CHAVE_MODO_RESULTADO = 'painel:resultado-modo';

/** Pergunta (ou muda) quanto o dono colocou na conta. */
function pedirCapital(s, aoSalvar) {
  const form = h('form', {
    class: 'form',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const { capital } = lerForm(form);
      if (await tentar(() => api('PUT', `/contas/${s.conta_id}/capital`, { capital_inicial: capital }), 'Valor salvo')) {
        dlg.fechar();
        aoSalvar();
      }
    },
  },
  h('p', { class: 'suave' }, `Quanto você colocou na ${s.nome} para o robô operar? O painel mostra o saldo subindo e descendo a partir desse valor.`),
  h('div', { class: 'campos' }, campo(`Valor colocado (${s.moeda})`, { name: 'capital', type: 'number', step: '0.01', min: '0', required: true, value: s.capital ?? '' })),
  h('div', { class: 'acoes acoes-fim' }, botao('Salvar', { nomeIcone: 'ok', type: 'submit' })));
  const dlg = janela(`Valor colocado · ${s.nome}`, { icone: 'contas' }, form);
}

/** "Tinha 50, agora 48, agora 52": o saldo de cada conta real contra o que o dono colocou. */
function cartaoSaldo(recarregarResultado) {
  const corpo = h('div', { class: 'saldo-contas' });
  const el = h('div', { class: 'cartao saldo' },
    h('div', { class: 'cartao-topo' }, h('div', {}, h('h2', {}, 'Seu saldo'), h('p', { class: 'suave' }, 'O que você colocou em cada conta, mais os ganhos e as perdas do robô (fechados e em aberto)'))),
    corpo);
  let assinatura = '';
  function atualizar(saldos) {
    const nova = JSON.stringify(saldos);
    if (nova === assinatura) return;
    assinatura = nova;
    if (!saldos?.length) {
      corpo.replaceChildren(h('p', { class: 'suave' }, 'Nenhuma conta real ainda.'));
      return;
    }
    corpo.replaceChildren(...saldos.map((s) => {
      if (s.capital === null) {
        return h('div', { class: 'saldo-conta' },
          h('strong', {}, s.nome), h('p', { class: 'suave' }, 'Diga quanto você colocou nesta conta para ver o saldo subindo e descendo.'),
          botao('Informar o valor colocado', { classe: 'pequeno', nomeIcone: 'editar', onclick: () => pedirCapital(s, recarregarResultado) }));
      }
      const classe = classeDe(s.variacao);
      return h('div', { class: 'saldo-conta' },
        h('div', { class: 'saldo-topo' },
          h('div', {}, h('span', { class: 'suave' }, `${s.nome} · ${s.exchange}`),
            h('div', { class: 'saldo-valor' }, h('strong', { class: 'mono' }, `${s.moeda} ${fmt(s.saldo)}`),
              h('span', { class: `saldo-variacao ${classe}` }, `${sinalDe(s.variacao)} (${s.variacao_pct === null ? '—' : `${s.variacao_pct > 0 ? '+' : ''}${fmt(s.variacao_pct)}%`})`))),
          botao('Mudar valor colocado', { classe: 'pequeno secundario', nomeIcone: 'editar', onclick: () => pedirCapital(s, recarregarResultado) })),
        h('p', { class: 'suave pequeno-texto' }, `Você colocou ${fmt(s.capital)} · operações fechadas ${sinalDe(s.realizado)} · em aberto ${sinalDe(s.em_aberto)}`),
        graficoSaldo(s.serie, s.capital));
    }));
  }
  return { el, atualizar };
}

/** Ganhos e perdas das operações fechadas, com o gráfico por dia; recarrega sozinho sem piscar. */
function cartaoResultado(aoReceberSaldos = () => {}) {
  let modo = 'real';
  try {
    modo = localStorage.getItem(CHAVE_MODO_RESULTADO) || 'real';
  } catch {
    // sem armazenamento: começa no real
  }
  let assinatura = '';
  let moedaEscolhida = null;
  const corpo = h('div', { class: 'resultado-corpo' });
  const botoes = [['real', 'Real'], ['simulacao', 'Simulação'], ['todos', 'Tudo']].map(([id, texto]) =>
    h('button', {
      type: 'button', class: id === modo ? 'escolhido' : '',
      onclick: () => {
        modo = id;
        try {
          localStorage.setItem(CHAVE_MODO_RESULTADO, id);
        } catch {
          // fica só agora
        }
        for (const b of botoes) b.classList.toggle('escolhido', b === botoes.find((x) => x.dataset.modo === id));
        assinatura = '';
        carregar();
      },
      'data-modo': id,
    }, texto));
  const el = h('div', { class: 'cartao resultado' },
    h('div', { class: 'cartao-topo' },
      h('div', {}, h('h2', {}, 'Ganhos e perdas'), h('p', { class: 'suave' }, 'Resultado de cada operação fechada (compra e depois venda), líquido de taxa, nos últimos 30 dias')),
      h('div', { class: 'segmentado', role: 'group', 'aria-label': 'Qual dinheiro' }, botoes)),
    corpo);

  function desenhar(d) {
    if (!d.moedas.length) {
      corpo.replaceChildren(vazio('Nenhuma operação fechada ainda', modo === 'real' ? 'O resultado aparece aqui quando uma compra de verdade for vendida (no alvo, no stop ou na proteção).' : 'O resultado aparece quando uma compra for vendida.', 'cotacao'));
      return;
    }
    const m = d.moedas.find((x) => x.moeda === moedaEscolhida) ?? d.moedas[0];
    moedaEscolhida = m.moeda;
    const numero = (rotulo, valor, classe = '', extra = '') => h('div', { class: 'resultado-numero' }, h('span', { class: 'suave' }, rotulo), h('strong', { class: `mono ${classe}` }, valor), extra ? h('small', { class: 'suave' }, extra) : null);
    corpo.replaceChildren(...[
      d.moedas.length > 1
        ? h('div', { class: 'fichas' }, d.moedas.map((x) => h('button', {
            type: 'button', class: `ficha ${x.moeda === m.moeda ? 'ficha-escolhida' : ''}`,
            onclick: () => {
              moedaEscolhida = x.moeda;
              desenhar(d);
            },
          }, `${x.moeda}: ${sinalDe(x.total)}`)))
        : null,
      h('div', { class: 'resultado-numeros' },
        numero('Resultado (30 dias)', `${sinalDe(m.por_dia.reduce((t, x) => t + x.resultado, 0))} ${m.moeda}`, classeDe(m.por_dia.reduce((t, x) => t + x.resultado, 0))),
        numero('Hoje', `${sinalDe(m.hoje)} ${m.moeda}`, classeDe(m.hoje)),
        numero('Operações', inteiro(m.operacoes), '', `${m.ganhas} ganhas · ${m.perdidas} perdidas`),
        numero('Acerto', m.acerto_pct === null ? '—' : `${fmt(m.acerto_pct, 0)}%`),
        numero('Maior ganho / perda', `${sinalDe(m.maior_ganho)} / ${sinalDe(m.maior_perda)}`)),
      graficoResultado(m.por_dia, m.moeda),
      h('div', { class: 'legenda-linha' },
        h('span', {}, h('i', { class: 'bolinha bolinha-ganho' }), 'Ganho no dia'),
        h('span', {}, h('i', { class: 'bolinha bolinha-perda' }), 'Perda no dia'),
        h('span', {}, h('i', { class: 'bolinha bolinha-compra' }), 'Acumulado (eixo da direita)')),
      d.ultimas.length
        ? h('ol', { class: 'feed resultado-ultimas' }, d.ultimas.filter((o) => o.moeda === m.moeda).slice(0, 8).map((o) =>
            h('li', { class: 'feed-item' },
              h('span', { class: `mono ${classeDe(o.resultado)}` }, `${o.resultado_pct > 0 ? '+' : ''}${fmt(o.resultado_pct)}%`),
              h('div', { class: 'feed-texto' }, h('strong', {}, o.simbolo), h('span', { class: 'suave' }, `${o.estrategia} · ${relativo(o.fechada_em)}`)),
              h('span', { class: `mono ${classeDe(o.resultado)}` }, sinalDe(o.resultado)))))
        : null,
    ].filter(Boolean));
  }

  async function carregar() {
    const d = await api('GET', `/resultado?modo=${modo}`).catch(() => null);
    if (!d) return;
    aoReceberSaldos(d.saldos ?? []);
    const nova = JSON.stringify(d);
    if (nova === assinatura) return; // nada mudou: não refaz (sem piscar)
    assinatura = nova;
    desenhar(d);
  }
  carregar();
  return { el, carregar };
}

const TEXTO_SITUACAO = { executado: 'executado', rejeitado: 'recusado', ignorado: 'ignorado', erro: 'erro', alerta: 'aviso' };
const CLASSE_SITUACAO = { executado: 'ok', rejeitado: 'alerta', ignorado: 'neutro', erro: 'perigo', alerta: 'ia' };

/** O que está acontecendo agora: cada sinal e ordem entra no topo, sem recarregar a página. */
function cartaoAoVivo() {
  const lista = h('ol', { class: 'feed ao-vivo-lista', 'aria-live': 'polite' });
  const quando = h('span', { class: 'suave ao-vivo-quando' }, 'conectando…');
  let ultimoId = 0;
  let atualizadoEm = 0;
  const linha = (e, nova) => {
    const ordem = e.ordem;
    const lado = e.acao === 'comprar' ? 'compra' : 'venda';
    return h('li', { class: `feed-item ${nova ? 'entrando' : ''} ${e.situacao === 'erro' ? 'feed-erro' : ''}`, 'data-quando': e.recebido_em },
      seloLado(lado),
      h('div', { class: 'feed-texto' },
        h('strong', {}, `${e.simbolo ?? ''} · ${e.estrategia ?? 'estratégia apagada'}`),
        h('span', { class: 'suave' }, ordem
          ? `${ordem.modo === 'real' ? 'REAL' : 'simulação'}: ${fmt(Number(ordem.custo))} a ${precoCompacto(Number(ordem.preco))}`
          : (e.motivo ?? e.motivo_sinal ?? '').slice(0, 110)),
        h('span', { class: 'suave pequeno-texto quando-relativo' }, relativo(e.recebido_em))),
      selo(TEXTO_SITUACAO[e.situacao] ?? e.situacao, CLASSE_SITUACAO[e.situacao] ?? 'neutro'));
  };
  const el = h('div', { class: 'cartao ao-vivo' },
    h('div', { class: 'cartao-topo' },
      h('div', {}, h('h2', {}, h('span', { class: 'ponto-vivo vivo' }), ' Ao vivo'), h('p', { class: 'suave' }, 'Sinais e ordens chegando, a cada poucos segundos')),
      quando),
    lista);
  function atualizar(eventos) {
    atualizadoEm = Date.now();
    const novos = eventos.filter((e) => e.id > ultimoId).reverse();
    const primeira = ultimoId === 0;
    for (const e of novos) {
      lista.prepend(linha(e, !primeira));
      ultimoId = Math.max(ultimoId, e.id);
    }
    while (lista.children.length > 15) lista.lastElementChild.remove();
    if (!lista.children.length) lista.replaceChildren(h('li', { class: 'suave ao-vivo-vazio' }, 'Nenhum sinal ainda. Os pilotos estão olhando o mercado.'));
    else lista.querySelector('.ao-vivo-vazio')?.remove();
  }
  function tique() {
    quando.textContent = atualizadoEm ? `atualizado há ${Math.max(0, Math.round((Date.now() - atualizadoEm) / 1000))} s` : 'conectando…';
    for (const li of lista.querySelectorAll('[data-quando]')) {
      const t = li.querySelector('.quando-relativo');
      if (t) t.textContent = relativo(li.dataset.quando);
    }
  }
  return { el, atualizar, tique };
}

export async function paginaPainel({ recarregar, agendar }) {
  const [r, diag] = await Promise.all([api('GET', '/resumo'), api('GET', '/diagnostico').catch(() => null)]);
  const serie = r.serie ?? [];
  const sinais = Object.fromEntries((r.sinais7d ?? []).map((x) => [x.situacao, Number(x.total)]));
  const totalSinais = Object.values(sinais).reduce((a, b) => a + b, 0);
  const exposicao = r.estrategias.reduce((t, e) => t + Number(e.custo_posicao), 0);
  const ativas = r.estrategias.filter((e) => e.ativa).length;
  const emReal = r.estrategias.filter((e) => e.real && e.conta_modo === 'real' && r.real_no_servidor).length;

  // ao vivo: os números e o feed a cada 5 s, o resultado e o diagnóstico a cada 30 s, sem recarregar
  const vivos = new Map();
  let resultado = null;
  const saldo = cartaoSaldo(() => resultado?.carregar());
  resultado = cartaoResultado((s) => saldo.atualizar(s));
  const aoVivo = cartaoAoVivo();
  const caixaDiag = h('div', {}, diag && diag.grupos.length ? cartaoDiagnostico(diag) : null);
  let assinaturaDiag = JSON.stringify(diag);
  const atualizarVivo = async () => {
    const d = await api('GET', '/ao-vivo').catch(() => null);
    if (!d) return;
    const novos = { ordens: Number(d.hoje.ordens), compras: Number(d.hoje.compras), vendas: Number(d.hoje.vendas), erros: Number(d.hoje.erros), exposicao: Number(d.exposicao.total) };
    for (const [chave, valor] of Object.entries(novos)) {
      const k = vivos.get(chave);
      if (!k || k.valor === valor) continue;
      animarPara(k.numero, k.valor, valor, k.formato);
      k.valor = valor;
    }
    aoVivo.atualizar(d.eventos);
  };
  atualizarVivo();
  agendar(atualizarVivo, 5_000);
  agendar(() => aoVivo.tique(), 1_000);
  agendar(() => resultado.carregar(), 30_000);
  agendar(async () => {
    const d = await api('GET', '/diagnostico').catch(() => null);
    if (!d || JSON.stringify(d) === assinaturaDiag) return;
    assinaturaDiag = JSON.stringify(d);
    caixaDiag.replaceChildren(d.grupos.length ? cartaoDiagnostico(d) : '');
  }, 30_000);

  const hoje = new Date(agora()).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: FUSO });

  return [
    cabecalho(`${saudacao()}!`, `Resumo da mesa · ${hoje}`,
      h('div', { class: 'fichas' },
        h('span', { class: 'ficha' }, icone('estrategias'), `${ativas} de ${r.estrategias.length} estratégias ativas`),
        h('span', { class: 'ficha ficha-ia' }, icone('ias'), `${r.ias?.ativas ?? 0} IA(s) ativa(s)`),
        h('span', { class: `ficha ${emReal ? 'ficha-perigo' : 'ficha-alerta'}` }, icone('escudo'), emReal ? `${emReal} em dinheiro real` : 'tudo em simulação'),
      ),
    ),
    h('div', { class: 'grade-kpi' }, escalonar([
      kpi('Ordens hoje', r.hoje.ordens, { nomeIcone: 'ordens', formato: inteiro, serie: serie.map((d) => Number(d.ordens)), cor: 'var(--primaria)', nota: '14 dias', vivos, chave: 'ordens' }),
      kpi('Compras hoje', r.hoje.compras, { nomeIcone: 'compra', serie: serie.map((d) => Number(d.compras)), cor: 'var(--ok)', nota: 'soma do dia: o mesmo dinheiro gira', vivos, chave: 'compras' }),
      kpi('Vendas hoje', r.hoje.vendas, { nomeIcone: 'venda', serie: serie.map((d) => Number(d.vendas)), cor: 'var(--ciano)', nota: 'soma do dia, líquido de taxa', vivos, chave: 'vendas' }),
      kpi('Exposição aberta', exposicao, { nomeIcone: 'contas', nota: 'custo das posições', vivos, chave: 'exposicao' }),
      kpi('Erros hoje', r.hoje.erros, { nomeIcone: 'alerta', formato: inteiro, classe: Number(r.hoje.erros) ? 'kpi-perigo' : '', nota: Number(r.hoje.erros) ? 'veja em Ordens' : 'nenhum', vivos, chave: 'erros' }),
    ])),
    saldo.el,
    cartaoParada(r, recarregar),
    h('div', { class: 'grade-2-1' }, resultado.el, aoVivo.el),
    caixaDiag,
    h('div', { class: 'grade-2-1' }, escalonar([
      h('div', { class: 'cartao' },
        h('div', { class: 'cartao-topo' }, h('div', {}, h('h2', {}, 'Volume negociado'), h('p', { class: 'suave' }, 'Compras e vendas executadas por dia, últimos 14 dias')),
          h('div', { class: 'legenda-linha' }, h('span', {}, h('i', { class: 'bolinha bolinha-compra' }), 'Compras'), h('span', {}, h('i', { class: 'bolinha bolinha-venda' }), 'Vendas'))),
        serie.length ? graficoArea(serie.map((d) => ({ ...d, compras: Number(d.compras), vendas: Number(d.vendas), ordens: Number(d.ordens) }))) : vazio('Sem dados ainda', null, 'cotacao'),
      ),
      h('div', { class: 'cartao' },
        h('div', { class: 'cartao-topo' }, h('div', {}, h('h2', {}, 'Sinais recebidos'), h('p', { class: 'suave' }, 'Últimos 7 dias, por situação'))),
        rosca([
          { rotulo: 'Executados', valor: sinais.executado ?? 0, cor: 'var(--ok)' },
          { rotulo: 'Rejeitados', valor: sinais.rejeitado ?? 0, cor: 'var(--alerta)' },
          { rotulo: 'Ignorados', valor: sinais.ignorado ?? 0, cor: 'var(--fraco)' },
          { rotulo: 'Erro', valor: sinais.erro ?? 0, cor: 'var(--perigo)' },
        ], inteiro(totalSinais), 'sinais'),
      ),
    ], 2)),
    h('div', { class: 'grade-2-1' }, escalonar([
      h('div', { class: 'cartao' },
        h('div', { class: 'cartao-topo' }, h('h2', {}, 'Estratégias'), h('a', { class: 'link', href: '#/estrategias' }, 'Gerenciar ', icone('seta'))),
        r.estrategias.length
          ? h('div', { class: 'lista-estrategias' }, r.estrategias.map((e) =>
              h('div', { class: 'linha-estrategia' },
                h('span', { class: `ponto-vivo ${e.ativa ? 'vivo' : ''}` }),
                h('div', { class: 'linha-estrategia-nome' }, h('strong', {}, e.nome), h('span', { class: 'suave' }, `${e.simbolo} · ${e.conta}`)),
                seloModo(e.real && e.conta_modo === 'real' && r.real_no_servidor ? 'real' : 'simulacao'),
                h('div', { class: 'linha-estrategia-pos' }, h('span', { class: 'mono' }, qtd(e.posicao)), h('span', { class: 'suave' }, `custo ${fmt(e.custo_posicao)}`)),
              )))
          : vazio('Nenhuma estratégia', 'Crie uma conta e depois uma estratégia para começar a receber sinais.', 'estrategias', h('a', { class: 'botao', href: '#/contas' }, 'Criar conta')),
      ),
      h('div', { class: 'cartao' },
        h('div', { class: 'cartao-topo' }, h('h2', {}, 'Últimas ordens'), h('a', { class: 'link', href: '#/ordens' }, 'Ver todas ', icone('seta'))),
        (r.ultimas ?? []).length
          ? h('ol', { class: 'feed' }, r.ultimas.map((o) =>
              h('li', { class: `feed-item ${o.situacao === 'erro' ? 'feed-erro' : ''}` },
                seloLado(o.lado),
                h('div', { class: 'feed-texto' }, h('strong', {}, o.simbolo), h('span', { class: 'suave' }, `${o.estrategia} · ${relativo(o.criada_em)}`)),
                h('div', { class: 'feed-valor' }, h('span', { class: 'mono' }, precoCompacto(o.custo)), o.situacao === 'erro' ? selo('erro', 'perigo') : seloModo(o.modo)),
              )))
          : vazio('Nenhuma ordem ainda', 'As ordens aparecem aqui assim que um sinal for executado.', 'ordens'),
      ),
    ], 4)),
    h('p', { class: 'rodape-pagina suave' }, icone('relogio'), `Aberto ${data(agora())} · os números e o "Ao vivo" se atualizam sozinhos a cada 5 s`),
  ];
}
