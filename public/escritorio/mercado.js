// Mercado FICTÍCIO para o escritório virtual. Nada aqui sai do navegador nem vira ordem.
//
// Cada ativo tem um preço que anda em "regimes" (alta, baixa, lateral) com ruído e saltos raros,
// para as médias se cruzarem de vez em quando e os robôs terem o que analisar. Quando houver dados
// reais, troque `criarMercadoFicticio` por uma fonte com a mesma forma:
//   { ativos, relogio, avancar(), aberto(ativo) }  e cada ativo com { historico, preco, ... }

// `categoria` agrupa os robôs na escala do dia; `horario` em horas de Brasília (null = 24 h)
export const CATEGORIAS = [
  { id: 'cripto', nome: 'Cripto' },
  { id: 'b3', nome: 'Bolsa B3' },
  { id: 'cambio', nome: 'Câmbio' },
  { id: 'commodities', nome: 'Commodities' },
  { id: 'eua', nome: 'Bolsa EUA' },
];

export const ATIVOS = [
  { id: 'btc', categoria: 'cripto', nome: 'Bitcoin', simbolo: 'BTC/USDT', mercado: 'Binance', preco: 68250, volDia: 0.035, horario: null, moeda: 'US$', casas: 0, cor: '#f7931a' },
  { id: 'eth', categoria: 'cripto', nome: 'Ethereum', simbolo: 'ETH/USDT', mercado: 'Binance', preco: 3420, volDia: 0.045, horario: null, moeda: 'US$', casas: 1, cor: '#8c6cf0' },
  { id: 'sol', categoria: 'cripto', nome: 'Solana', simbolo: 'SOL/USDT', mercado: 'Binance', preco: 172, volDia: 0.06, horario: null, moeda: 'US$', casas: 2, cor: '#19c59a' },
  { id: 'xrp', categoria: 'cripto', nome: 'XRP', simbolo: 'XRP/USDT', mercado: 'Binance', preco: 0.62, volDia: 0.055, horario: null, moeda: 'US$', casas: 4, cor: '#5b7cfa' },
  { id: 'acoes', categoria: 'b3', nome: 'Petrobras', simbolo: 'PETR4', mercado: 'B3', preco: 38.5, volDia: 0.022, horario: [10, 17], moeda: 'R$', casas: 2, cor: '#2e9e5b' },
  { id: 'vale', categoria: 'b3', nome: 'Vale', simbolo: 'VALE3', mercado: 'B3', preco: 61.2, volDia: 0.02, horario: [10, 17], moeda: 'R$', casas: 2, cor: '#e0a526' },
  { id: 'ibov', categoria: 'b3', nome: 'Ibovespa', simbolo: 'IBOV', mercado: 'B3', preco: 128400, volDia: 0.013, horario: [10, 17], moeda: 'pts', casas: 0, cor: '#3d8bfd' },
  { id: 'dolar', categoria: 'cambio', nome: 'Dólar', simbolo: 'USD/BRL', mercado: 'Câmbio', preco: 5.42, volDia: 0.009, horario: [9, 18], moeda: 'R$', casas: 4, cor: '#2fb67c' },
  { id: 'euro', categoria: 'cambio', nome: 'Euro', simbolo: 'EUR/USD', mercado: 'Forex', preco: 1.084, volDia: 0.006, horario: null, moeda: 'US$', casas: 4, cor: '#3b6fd8' },
  { id: 'ouro', categoria: 'commodities', nome: 'Ouro', simbolo: 'XAU/USD', mercado: 'Comex', preco: 2385, volDia: 0.011, horario: [8, 23], moeda: 'US$', casas: 1, cor: '#e3b23c' },
  { id: 'petroleo', categoria: 'commodities', nome: 'Petróleo', simbolo: 'BRENT', mercado: 'ICE', preco: 82.4, volDia: 0.02, horario: [8, 23], moeda: 'US$', casas: 2, cor: '#8a6a4a' },
  { id: 'spx', categoria: 'eua', nome: 'S&P 500', simbolo: 'SPX', mercado: 'NYSE', preco: 5420, volDia: 0.01, horario: [10.5, 17], moeda: 'pts', casas: 0, cor: '#d64545' },
];

const TAMANHO_HISTORICO = 260;

/** Gerador aleatório com semente (mulberry32), para a demonstração ser reproduzível. */
export function aleatorio(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand) {
  // Box-Muller
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ------------------------------------------------------------------ indicadores

export function media(serie, n) {
  if (serie.length < n) return null;
  let s = 0;
  for (let i = serie.length - n; i < serie.length; i++) s += serie[i];
  return s / n;
}

export function ifr(serie, n = 14) {
  if (serie.length <= n) return null;
  let ganho = 0;
  let perda = 0;
  for (let i = serie.length - n; i < serie.length; i++) {
    const d = serie[i] - serie[i - 1];
    if (d > 0) ganho += d;
    else perda -= d;
  }
  if (perda === 0) return 100;
  return 100 - 100 / (1 + ganho / perda);
}

/** Desvio-padrão dos retornos dos últimos n passos. */
export function volatilidade(serie, n = 30) {
  if (serie.length <= n) return null;
  const r = [];
  for (let i = serie.length - n; i < serie.length; i++) r.push(Math.log(serie[i] / serie[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
}

/** Séries de média móvel alinhadas ao histórico (null onde ainda não há pontos). Uma passada só. */
export function calcularMedias(ativo, periodos = [9, 26, 60]) {
  const h = ativo.historico;
  ativo.medias = {};
  for (const n of periodos) {
    const serie = new Array(h.length).fill(null);
    let soma = 0;
    for (let i = 0; i < h.length; i++) {
      soma += h[i];
      if (i >= n) soma -= h[i - n];
      if (i >= n - 1) serie[i] = soma / n;
    }
    ativo.medias[n] = serie;
  }
}

// ------------------------------------------------------------------ mercado

export function criarMercadoFicticio(semente = Date.now()) {
  const rand = aleatorio(semente);
  // relógio simulado em minutos desde o começo; começa num dia útil às 9h55
  const relogio = { minutos: 9 * 60 + 55, dia: 1 };

  const ativos = ATIVOS.map((base) => {
    const sigma = base.volDia / Math.sqrt(390); // por passo (um "minuto" de pregão)
    const a = {
      ...base,
      sigma,
      historico: [],
      regime: 0,
      regimeAte: 0,
      variacaoDia: 0,
      aberturaDia: base.preco,
    };
    // aquece o histórico para os gráficos não começarem vazios
    let p = base.preco;
    for (let i = 0; i < TAMANHO_HISTORICO; i++) {
      p *= Math.exp(sigma * normal(rand) + Math.sin(i / 23) * sigma * 0.25);
      a.historico.push(p);
    }
    a.preco = p;
    a.aberturaDia = p;
    calcularMedias(a);
    return a;
  });

  function aberto(ativo) {
    if (!ativo.horario) return true;
    const h = (relogio.minutos % 1440) / 60;
    return h >= ativo.horario[0] && h < ativo.horario[1];
  }

  function passoDoAtivo(a) {
    if (a.regimeAte <= 0) {
      // novo regime: tendência de alta, de baixa ou lateral, por 40 a 160 passos
      const sorte = rand();
      a.regime = sorte < 0.36 ? 1 : sorte < 0.72 ? -1 : 0;
      a.regimeAte = 40 + Math.floor(rand() * 120);
    }
    a.regimeAte--;
    const deriva = a.regime * a.sigma * 0.32;
    let r = deriva + a.sigma * normal(rand);
    if (rand() < 0.004) r += a.sigma * (rand() < 0.5 ? -6 : 6); // salto raro (notícia)
    a.preco *= Math.exp(r);
    a.historico.push(a.preco);
    if (a.historico.length > TAMANHO_HISTORICO) a.historico.shift();
    a.variacaoDia = a.preco / a.aberturaDia - 1;
    calcularMedias(a);
  }

  /** Avança um passo do relógio. Com B3 e câmbio fechados, a noite passa mais rápido. */
  function avancar() {
    const algumComHorarioAberto = ativos.some((a) => a.horario && aberto(a));
    const minutosAntes = relogio.minutos;
    relogio.minutos += algumComHorarioAberto ? 1 : 6;
    if (Math.floor(relogio.minutos / 1440) !== Math.floor(minutosAntes / 1440)) {
      relogio.dia++;
      for (const a of ativos) a.aberturaDia = a.preco;
    }
    for (const a of ativos) if (aberto(a)) passoDoAtivo(a);
  }

  function horaTexto() {
    const m = relogio.minutos % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  /** 0 = meia-noite, 1 = meio-dia: usado na luz das janelas */
  function luzDoDia() {
    const h = (relogio.minutos % 1440) / 60;
    return Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
  }

  return { ativos, relogio, avancar, aberto, horaTexto, luzDoDia, rand };
}

export function formatarPreco(ativo, valor) {
  const numero = valor.toLocaleString('pt-BR', { minimumFractionDigits: ativo.casas, maximumFractionDigits: ativo.casas });
  return ativo.moeda === 'pts' ? `${numero} pts` : `${ativo.moeda} ${numero}`;
}
