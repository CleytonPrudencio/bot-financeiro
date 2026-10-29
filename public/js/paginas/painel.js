import {
  api, botaoSegurar, cabecalho, confirmar, contar, data, escalonar, fmt, h, icone, inteiro, precoCompacto,
  qtd, relativo, selo, seloLado, seloModo, tentar, vazio,
} from '../base.js';
import { graficoArea, linhaPequena, rosca } from '../graficos.js';

function saudacao() {
  const hora = Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }));
  return hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
}

function kpi(rotulo, valor, { nomeIcone, formato = (v) => fmt(v), serie, cor, nota, classe = '' }) {
  const numero = h('div', { class: 'kpi-valor' }, '0');
  contar(numero, valor, formato);
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

export async function paginaPainel({ recarregar, agendar }) {
  const r = await api('GET', '/resumo');
  const serie = r.serie ?? [];
  const sinais = Object.fromEntries((r.sinais7d ?? []).map((x) => [x.situacao, Number(x.total)]));
  const totalSinais = Object.values(sinais).reduce((a, b) => a + b, 0);
  const exposicao = r.estrategias.reduce((t, e) => t + Number(e.custo_posicao), 0);
  const ativas = r.estrategias.filter((e) => e.ativa).length;
  const emReal = r.estrategias.filter((e) => e.real && e.conta_modo === 'real' && r.real_no_servidor).length;

  // atualiza sozinho enquanto a página está aberta
  agendar(() => recarregar({ suave: true }), 30_000);

  const hoje = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' });

  return [
    cabecalho(`${saudacao()}!`, `Resumo da mesa · ${hoje}`,
      h('div', { class: 'fichas' },
        h('span', { class: 'ficha' }, icone('estrategias'), `${ativas} de ${r.estrategias.length} estratégias ativas`),
        h('span', { class: 'ficha ficha-ia' }, icone('ias'), `${r.ias?.ativas ?? 0} IA(s) ativa(s)`),
        h('span', { class: `ficha ${emReal ? 'ficha-perigo' : 'ficha-alerta'}` }, icone('escudo'), emReal ? `${emReal} em dinheiro real` : 'tudo em simulação'),
      ),
    ),
    h('div', { class: 'grade-kpi' }, escalonar([
      kpi('Ordens hoje', r.hoje.ordens, { nomeIcone: 'ordens', formato: inteiro, serie: serie.map((d) => Number(d.ordens)), cor: 'var(--primaria)', nota: '14 dias' }),
      kpi('Compras hoje', r.hoje.compras, { nomeIcone: 'compra', serie: serie.map((d) => Number(d.compras)), cor: 'var(--ok)', nota: 'moeda de cotação' }),
      kpi('Vendas hoje', r.hoje.vendas, { nomeIcone: 'venda', serie: serie.map((d) => Number(d.vendas)), cor: 'var(--ciano)', nota: 'líquido de taxa' }),
      kpi('Exposição aberta', exposicao, { nomeIcone: 'contas', nota: 'custo das posições' }),
      kpi('Erros hoje', r.hoje.erros, { nomeIcone: 'alerta', formato: inteiro, classe: Number(r.hoje.erros) ? 'kpi-perigo' : '', nota: Number(r.hoje.erros) ? 'veja em Ordens' : 'nenhum' }),
    ])),
    cartaoParada(r, recarregar),
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
    h('p', { class: 'rodape-pagina suave' }, icone('relogio'), `Atualizado ${data(new Date().toISOString())} · atualiza sozinho a cada 30 s`),
  ];
}
