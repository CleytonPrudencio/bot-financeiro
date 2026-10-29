// Tudo que é desenho do escritório. Coordenadas lógicas de 1280 x 720; quem chama já aplicou a
// escala do canvas. Nenhuma função aqui muda estado do jogo, só desenha.

export const LARGURA = 1280;
export const ALTURA = 720;
export const CHAO_Y = 230; // onde a parede encontra o chão

const SALA = { esq: 470, dir: 810, fundo: CHAO_Y, frente: 305, portaEsq: 598, portaDir: 682 };
export { SALA };

/**
 * As 8 mesas do escritório (duas fileiras, dos dois lados do corredor). `lado` é onde o robô fica
 * em relação à mesa: o monitor vai do outro lado. Quem está escalado ocupa uma mesa livre.
 */
export const VAGAS_MESA = [
  { x: 155, y: 480, lado: -1 },
  { x: 400, y: 480, lado: 1 },
  { x: 880, y: 480, lado: -1 },
  { x: 1125, y: 480, lado: 1 },
  { x: 165, y: 665, lado: -1 },
  { x: 400, y: 665, lado: 1 },
  { x: 880, y: 665, lado: -1 },
  { x: 1115, y: 665, lado: 1 },
];

/** Faixa do chão entre a sala de descanso e as mesas: por onde se anda para descansar. */
export const FAIXA_DESCANSO_Y = 352;

/**
 * Lugares na sala de descanso (fundo à esquerda: sofá e pufes) e no cantinho do café (fundo à
 * direita). `caneca`: o robô fica com uma xícara na mão em vez de cochilar.
 */
export const VAGAS_DESCANSO = [
  { x: 150, y: 296, lado: 'esq' },
  { x: 215, y: 296, lado: 'esq' },
  { x: 280, y: 296, lado: 'esq' },
  { x: 345, y: 296, lado: 'esq' },
  { x: 165, y: 336, lado: 'esq' },
  { x: 245, y: 338, lado: 'esq' },
  { x: 325, y: 338, lado: 'esq', caneca: true },
  { x: 405, y: 334, lado: 'esq', caneca: true },
  { x: 905, y: 300, lado: 'dir', caneca: true },
  { x: 985, y: 302, lado: 'dir', caneca: true },
  { x: 1065, y: 302, lado: 'dir' },
  { x: 1140, y: 306, lado: 'dir', caneca: true },
];

/** Robôs um pouco maiores que o resto do cenário, para ler bem as expressões. */
export const TAMANHO_ROBO = 1.32;

/** Escala de perspectiva: mais perto da câmera (y maior), maior. */
export const escalaEm = (y) => 0.62 + 0.5 * ((y - CHAO_Y) / (ALTURA - CHAO_Y));

const misturar = (a, b, t) => {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`;
};

function retanguloArredondado(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// ------------------------------------------------------------------ cenário fixo (pré-renderizado)

export function desenharCenarioFixo(ctx, rand) {
  // parede
  const parede = ctx.createLinearGradient(0, 0, 0, CHAO_Y);
  parede.addColorStop(0, '#2a3244');
  parede.addColorStop(1, '#353f55');
  ctx.fillStyle = parede;
  ctx.fillRect(0, 0, LARGURA, CHAO_Y);

  // janelas: deixa buracos transparentes (o céu é desenhado por baixo a cada quadro)
  for (const [x0, x1] of [[40, 440], [840, 1240]]) {
    for (let x = x0; x < x1; x += 100) {
      ctx.clearRect(x + 6, 34, 88, 150);
    }
  }
  // caixilhos
  ctx.fillStyle = '#1d2433';
  for (const [x0, x1] of [[40, 440], [840, 1240]]) {
    ctx.fillRect(x0, 28, x1 - x0, 6);
    ctx.fillRect(x0, 184, x1 - x0, 8);
    for (let x = x0; x <= x1; x += 100) ctx.fillRect(x, 28, 6, 164);
  }

  // rodapé
  ctx.fillStyle = '#1b2130';
  ctx.fillRect(0, CHAO_Y - 10, LARGURA, 10);

  // chão de madeira em perspectiva
  const chao = ctx.createLinearGradient(0, CHAO_Y, 0, ALTURA);
  chao.addColorStop(0, '#6b5640');
  chao.addColorStop(1, '#8a6e50');
  ctx.fillStyle = chao;
  ctx.fillRect(0, CHAO_Y, LARGURA, ALTURA - CHAO_Y);
  ctx.strokeStyle = 'rgba(40, 28, 18, 0.25)';
  ctx.lineWidth = 1;
  const fuga = { x: LARGURA / 2, y: -420 };
  for (let i = -14; i <= 14; i++) {
    const xBase = LARGURA / 2 + i * 120;
    ctx.beginPath();
    const t = (CHAO_Y - fuga.y) / (ALTURA - fuga.y);
    ctx.moveTo(fuga.x + (xBase - fuga.x) * t, CHAO_Y);
    ctx.lineTo(xBase, ALTURA);
    ctx.stroke();
  }
  for (let y = CHAO_Y + 12, passo = 14; y < ALTURA; y += passo, passo *= 1.08) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(LARGURA, y);
    ctx.stroke();
  }

  // tapete do corredor
  ctx.fillStyle = 'rgba(30, 55, 90, 0.55)';
  ctx.beginPath();
  ctx.moveTo(560, 330);
  ctx.lineTo(720, 330);
  ctx.lineTo(760, 560);
  ctx.lineTo(520, 560);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(30, 55, 90, 0.4)';
  ctx.fillRect(0, 498, LARGURA, 50);

  // sala do chefe: piso e parede do fundo
  ctx.fillStyle = '#4c5d78';
  ctx.beginPath();
  ctx.moveTo(SALA.esq, SALA.fundo);
  ctx.lineTo(SALA.dir, SALA.fundo);
  ctx.lineTo(SALA.dir + 20, SALA.frente);
  ctx.lineTo(SALA.esq - 20, SALA.frente);
  ctx.closePath();
  ctx.fill();
  const fundoSala = ctx.createLinearGradient(0, 60, 0, CHAO_Y);
  fundoSala.addColorStop(0, '#1f2a3e');
  fundoSala.addColorStop(1, '#2a3a55');
  ctx.fillStyle = fundoSala;
  ctx.fillRect(SALA.esq, 60, SALA.dir - SALA.esq, CHAO_Y - 60);
  ctx.fillStyle = '#e8c35a';
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('DIRETORIA DE RISCO', (SALA.esq + SALA.dir) / 2, 80);

  desenharSalaDescanso(ctx);
  desenharCantinhoCafe(ctx);

  // plantas
  for (const [x, y, s] of [[1225, 318, 0.9], [640, 712, 0.8]]) {
    desenharPlanta(ctx, x, y, s, rand);
  }
}

/** Fundo à esquerda: tapete, sofá, pufes, mesinha, máquina de café e a placa na parede. */
function desenharSalaDescanso(ctx) {
  // tapete
  ctx.fillStyle = 'rgba(120, 72, 140, 0.35)';
  ctx.beginPath();
  ctx.ellipse(265, 312, 205, 44, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(230, 190, 255, 0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(265, 312, 190, 38, 0, 0, Math.PI * 2);
  ctx.stroke();

  // placa na parede
  ctx.fillStyle = 'rgba(11, 16, 32, 0.85)';
  retanguloArredondado(ctx, 160, 150, 210, 22, 6);
  ctx.fill();
  ctx.fillStyle = '#d9b8ff';
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('☾  SALA DE DESCANSO', 265, 165);

  // sofá (encosto, assento e braços)
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(248, 300, 140, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#4b3a6b';
  retanguloArredondado(ctx, 112, 240, 272, 40, 12);
  ctx.fill();
  ctx.fillStyle = '#5d4a85';
  retanguloArredondado(ctx, 112, 272, 272, 24, 8);
  ctx.fill();
  ctx.fillStyle = '#3d2f58';
  retanguloArredondado(ctx, 100, 252, 24, 46, 8);
  ctx.fill();
  retanguloArredondado(ctx, 372, 252, 24, 46, 8);
  ctx.fill();
  // almofadas
  for (const x of [150, 215, 280, 345]) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    retanguloArredondado(ctx, x - 26, 274, 52, 10, 4);
    ctx.fill();
  }

  // pufes
  for (const [x, y, cor] of [[165, 336, '#d0704a'], [245, 338, '#3f8fb0'], [325, 338, '#c9a23a'], [405, 334, '#6a9e4f']]) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(x, y + 2, 28, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.ellipse(x, y - 6, 26, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.ellipse(x - 6, y - 10, 12, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // máquina de café
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(52, 300, 26, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2a2f3a';
  retanguloArredondado(ctx, 32, 236, 40, 64, 6);
  ctx.fill();
  ctx.fillStyle = '#c0362c';
  ctx.fillRect(36, 244, 32, 6);
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(40, 258, 24, 20);
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(47, 270, 10, 8);
}

/** Fundo à direita: balcão com cafeteira, xícaras e um quadro de avisos. */
function desenharCantinhoCafe(ctx) {
  ctx.fillStyle = 'rgba(11, 16, 32, 0.85)';
  retanguloArredondado(ctx, 905, 150, 150, 22, 6);
  ctx.fill();
  ctx.fillStyle = '#ffd8a8';
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('☕  CANTINHO DO CAFÉ', 980, 165);
  // balcão
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(1020, 282, 170, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#c8b59a';
  ctx.beginPath();
  ctx.moveTo(860, 248);
  ctx.lineTo(1180, 248);
  ctx.lineTo(1190, 258);
  ctx.lineTo(850, 258);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#7a5a3e';
  ctx.fillRect(850, 258, 340, 24);
  ctx.fillStyle = '#5e4430';
  for (let x = 870; x < 1180; x += 56) ctx.fillRect(x, 262, 44, 16);
  // cafeteira e xícaras
  ctx.fillStyle = '#2a2f3a';
  retanguloArredondado(ctx, 880, 222, 28, 28, 4);
  ctx.fill();
  ctx.fillStyle = '#ffb347';
  ctx.fillRect(884, 228, 20, 4);
  for (const x of [940, 962, 984, 1100, 1122]) {
    ctx.fillStyle = '#f2f2f2';
    retanguloArredondado(ctx, x, 240, 12, 10, 2);
    ctx.fill();
  }
  // banquetas
  for (const x of [905, 985, 1065, 1140]) {
    ctx.fillStyle = '#3a3f4c';
    ctx.fillRect(x - 2, 288, 4, 14);
    ctx.beginPath();
    ctx.ellipse(x, 288, 13, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function desenharPlanta(ctx, x, y, s, rand) {
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, y, 26 * s, 7 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#c9663f';
  ctx.beginPath();
  ctx.moveTo(x - 20 * s, y - 40 * s);
  ctx.lineTo(x + 20 * s, y - 40 * s);
  ctx.lineTo(x + 15 * s, y);
  ctx.lineTo(x - 15 * s, y);
  ctx.closePath();
  ctx.fill();
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI / 2 + (rand() - 0.5) * 2.2;
    const comp = (40 + rand() * 40) * s;
    ctx.strokeStyle = i % 2 ? '#3e8f58' : '#2f7a49';
    ctx.lineWidth = 9 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y - 40 * s);
    ctx.quadraticCurveTo(x + Math.cos(a) * comp * 0.4, y - 40 * s - comp * 0.6, x + Math.cos(a) * comp, y - 40 * s + Math.sin(a) * comp);
    ctx.stroke();
  }
}

// ------------------------------------------------------------------ céu, luz e quadro de cotações

export function desenharCeu(ctx, luz, t, predios) {
  const ceu = ctx.createLinearGradient(0, 30, 0, 190);
  ceu.addColorStop(0, misturar('0b1326', '5ea8e8', luz));
  ceu.addColorStop(1, misturar('1d2540', 'f2c79b', luz * 0.85));
  ctx.fillStyle = ceu;
  ctx.fillRect(40, 30, 1200, 160);
  if (luz < 0.35) {
    ctx.fillStyle = `rgba(255,255,255,${(0.35 - luz) * 2})`;
    for (let i = 0; i < 40; i++) {
      const x = 40 + ((i * 137) % 1200);
      const y = 36 + ((i * 53) % 70);
      ctx.fillRect(x, y, 1.5, 1.5);
    }
  }
  // prédios ao longe, com deslocamento lento (parallax)
  const deslocamento = (t * 4) % 1200;
  for (const p of predios) {
    const x = 40 + ((p.x - deslocamento + 1200) % 1200);
    ctx.fillStyle = misturar('121a2c', '7d8fb0', luz * 0.6);
    ctx.fillRect(x, 190 - p.h, p.w, p.h);
    if (luz < 0.55) {
      ctx.fillStyle = 'rgba(255, 214, 120, 0.75)';
      for (let j = 0; j < p.janelas.length; j++) {
        const [jx, jy] = p.janelas[j];
        ctx.fillRect(x + jx, 190 - p.h + jy, 3, 4);
      }
    }
  }
}

export function gerarPredios(rand) {
  const predios = [];
  for (let x = 0; x < 1200; x += 30 + rand() * 40) {
    const w = 24 + rand() * 36;
    const h = 40 + rand() * 110;
    const janelas = [];
    for (let i = 0; i < 14; i++) if (rand() < 0.6) janelas.push([4 + rand() * (w - 8), 6 + rand() * (h - 12)]);
    predios.push({ x, w, h, janelas });
  }
  return predios;
}

export function desenharQuadroCotacoes(ctx, ativos, t, hora, dia) {
  const x = SALA.esq + 20;
  const y = 92;
  const w = SALA.dir - SALA.esq - 40;
  ctx.fillStyle = '#0b1020';
  retanguloArredondado(ctx, x, y, w, 26, 4);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 4, y, w - 8, 26);
  ctx.clip();
  ctx.font = '600 13px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  const itens = ativos.map((a) => {
    const v = a.variacaoDia * 100;
    return { texto: `${a.simbolo} ${a.preco.toFixed(a.casas)} ${v >= 0 ? '▲' : '▼'}${Math.abs(v).toFixed(2)}%`, cor: v >= 0 ? '#3ddc84' : '#ff6b6b' };
  });
  const larguraItem = 210;
  const total = larguraItem * itens.length;
  const desloc = (t * 40) % total;
  for (let rep = 0; rep < 3; rep++) {
    itens.forEach((it, i) => {
      ctx.fillStyle = it.cor;
      ctx.fillText(it.texto, x + 8 + rep * total + i * larguraItem - desloc, y + 18);
    });
  }
  ctx.restore();
  // relógio de parede
  ctx.fillStyle = '#0b1020';
  retanguloArredondado(ctx, 1090, 148, 120, 26, 5);
  ctx.fillStyle = 'rgba(11,16,32,0.85)';
  ctx.fill();
  ctx.fillStyle = '#9fe7ff';
  ctx.textAlign = 'center';
  ctx.font = '600 14px ui-monospace, Consolas, monospace';
  ctx.fillText(`dia ${dia} · ${hora}`, 1150, 166);
}

/** Escurece e tinge de azul à noite, e acende as luminárias. */
export function desenharLuz(ctx, luz, t) {
  const noite = 1 - luz;
  if (noite > 0.05) {
    ctx.fillStyle = `rgba(10, 18, 45, ${noite * 0.38})`;
    ctx.fillRect(0, 0, LARGURA, ALTURA);
  }
  for (const x of [250, 640, 1030]) {
    const g = ctx.createRadialGradient(x, 40, 4, x, 260, 330);
    const pulso = 0.02 * Math.sin(t * 2 + x);
    g.addColorStop(0, `rgba(255, 228, 170, ${0.16 + noite * 0.22 + pulso})`);
    g.addColorStop(1, 'rgba(255, 228, 170, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 330, 0, 660, ALTURA);
    ctx.fillStyle = '#d9d2c0';
    ctx.fillRect(x - 1, 0, 2, 18);
    ctx.beginPath();
    ctx.ellipse(x, 22, 26, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ------------------------------------------------------------------ mesas e monitores

/** Mesa de uma vaga. Sem `ativo`, é uma mesa livre (monitor desligado). */
export function desenharMesa(ctx, vaga, ativo, robo, t, aberto) {
  const { x, y } = vaga;
  const s = escalaEm(y);
  const largura = 190 * s;
  const fundo = 46 * s;
  const altura = 54 * s;

  // sombra
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, y + 6 * s, largura * 0.6, 12 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // tampo (paralelogramo) e frente
  ctx.fillStyle = '#d8dde6';
  ctx.beginPath();
  ctx.moveTo(x - largura / 2 + 10 * s, y - altura - fundo);
  ctx.lineTo(x + largura / 2 - 10 * s, y - altura - fundo);
  ctx.lineTo(x + largura / 2, y - altura);
  ctx.lineTo(x - largura / 2, y - altura);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#aeb6c4';
  ctx.fillRect(x - largura / 2, y - altura, largura, 10 * s);
  // painel da frente com a cor do ativo
  ctx.fillStyle = '#5b6476';
  ctx.fillRect(x - largura / 2 + 6 * s, y - altura + 10 * s, largura - 12 * s, altura - 10 * s);
  ctx.fillStyle = ativo?.cor ?? '#8a93a6';
  ctx.fillRect(x - largura / 2 + 6 * s, y - altura + 10 * s, largura - 12 * s, 4 * s);
  ctx.fillStyle = ativo ? '#e9edf3' : '#aab3c2';
  ctx.font = `600 ${Math.round(13 * s)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(ativo ? `${ativo.nome} · ${ativo.simbolo}` : 'mesa livre', x, y - 16 * s);

  // monitor do lado oposto ao robô, virado para a câmera
  const ladoMonitor = -vaga.lado;
  const mx = x + ladoMonitor * 38 * s;
  const my = y - altura - fundo * 0.45;
  if (!ativo) {
    desenharMonitorDesligado(ctx, mx, my, s);
    return;
  }
  desenharMonitor(ctx, mx, my, s, ativo, robo, t, aberto);

  // caneca com vapor
  const cx = x - ladoMonitor * 62 * s;
  const cy = y - altura - 12 * s;
  ctx.fillStyle = '#f2f2f2';
  retanguloArredondado(ctx, cx - 6 * s, cy - 12 * s, 12 * s, 13 * s, 2 * s);
  ctx.fill();
  ctx.fillStyle = ativo.cor;
  ctx.fillRect(cx - 6 * s, cy - 7 * s, 12 * s, 3 * s);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5 * s;
  for (let i = 0; i < 2; i++) {
    const fase = t * 1.5 + i * 2;
    ctx.beginPath();
    ctx.moveTo(cx - 2 * s + i * 4 * s, cy - 14 * s);
    ctx.quadraticCurveTo(cx + Math.sin(fase) * 5 * s, cy - 22 * s, cx + Math.sin(fase + 1) * 3 * s, cy - 30 * s);
    ctx.stroke();
  }
}

function desenharMonitorDesligado(ctx, x, y, s) {
  const w = 104 * s;
  const h = 66 * s;
  ctx.fillStyle = '#2b3140';
  ctx.fillRect(x - 5 * s, y - 6 * s, 10 * s, 12 * s);
  ctx.fillRect(x - 20 * s, y + 4 * s, 40 * s, 4 * s);
  ctx.fillStyle = '#1b1f29';
  retanguloArredondado(ctx, x - w / 2, y - h - 4 * s, w, h, 4 * s);
  ctx.fill();
  ctx.fillStyle = '#05080f';
  ctx.fillRect(x - w / 2 + 4 * s, y - h, w - 8 * s, h - 8 * s);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(x - w / 2 + 4 * s, y - h, (w - 8 * s) * 0.4, h - 8 * s);
}

function desenharMonitor(ctx, x, y, s, ativo, robo, t, aberto) {
  const w = 104 * s;
  const h = 66 * s;
  // pé
  ctx.fillStyle = '#2b3140';
  ctx.fillRect(x - 5 * s, y - 6 * s, 10 * s, 12 * s);
  ctx.fillRect(x - 20 * s, y + 4 * s, 40 * s, 4 * s);
  // moldura
  ctx.fillStyle = '#1b1f29';
  retanguloArredondado(ctx, x - w / 2, y - h - 4 * s, w, h, 4 * s);
  ctx.fill();
  const tx = x - w / 2 + 4 * s;
  const ty = y - h;
  const tw = w - 8 * s;
  const th = h - 8 * s;
  ctx.fillStyle = aberto ? '#08111f' : '#05080f';
  ctx.fillRect(tx, ty, tw, th);
  if (!aberto) {
    ctx.fillStyle = 'rgba(160,180,210,0.6)';
    ctx.font = `600 ${Math.round(11 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('mercado fechado', x, ty + th / 2 + 4 * s);
    return;
  }
  // gráfico
  const serie = ativo.historico.slice(-80);
  let min = Infinity;
  let max = -Infinity;
  for (const v of serie) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const faixa = max - min || 1;
  const px = (i) => tx + 2 * s + (i / (serie.length - 1)) * (tw - 4 * s);
  const py = (v) => ty + th - 10 * s - ((v - min) / faixa) * (th - 18 * s);
  const subindo = serie[serie.length - 1] >= serie[0];
  ctx.strokeStyle = subindo ? '#3ddc84' : '#ff6b6b';
  ctx.lineWidth = 1.6 * s;
  ctx.beginPath();
  serie.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.stroke();
  // média curta e longa
  for (const [n, cor] of [[9, '#ffd166'], [26, '#7cc4ff']]) {
    ctx.strokeStyle = cor;
    ctx.lineWidth = 1 * s;
    ctx.beginPath();
    let comecou = false;
    const medias = ativo.medias[n].slice(-serie.length);
    for (let i = 0; i < serie.length; i++) {
      const m = medias[i];
      if (m === null) continue;
      if (!comecou) {
        ctx.moveTo(px(i), py(m));
        comecou = true;
      } else ctx.lineTo(px(i), py(m));
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#d8e6ff';
  ctx.font = `600 ${Math.round(10 * s)}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'left';
  ctx.fillText(ativo.preco.toFixed(ativo.casas), tx + 3 * s, ty + 10 * s);
  // flash de sinal ou de execução
  if (robo.flash && robo.flash.ate > t) {
    const k = (robo.flash.ate - t) / robo.flash.duracao;
    ctx.fillStyle = robo.flash.cor.replace('ALFA', (0.55 * k).toFixed(2));
    ctx.fillRect(tx, ty, tw, th);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(12 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(robo.flash.texto, x, ty + th / 2 + 4 * s);
  }
  // reflexo
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx + tw * 0.45, ty);
  ctx.lineTo(tx + tw * 0.2, ty + th);
  ctx.lineTo(tx, ty + th);
  ctx.closePath();
  ctx.fill();
}

// ------------------------------------------------------------------ sala do chefe

export function desenharMesaChefe(ctx, t) {
  const x = 640;
  const y = 290;
  const s = escalaEm(y) * 1.15;
  const largura = 230 * s;
  const altura = 50 * s;
  const fundo = 40 * s;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(x, y + 4 * s, largura * 0.6, 10 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3b2b22';
  ctx.beginPath();
  ctx.moveTo(x - largura / 2 + 12 * s, y - altura - fundo);
  ctx.lineTo(x + largura / 2 - 12 * s, y - altura - fundo);
  ctx.lineTo(x + largura / 2, y - altura);
  ctx.lineTo(x - largura / 2, y - altura);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#5a4030';
  ctx.fillRect(x - largura / 2, y - altura, largura, altura);
  ctx.fillStyle = '#e8c35a';
  ctx.fillRect(x - largura / 2, y - altura, largura, 3 * s);
  ctx.font = `700 ${Math.round(12 * s)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('CHEFE', x, y - altura / 2 + 4 * s);
  // luminária da mesa
  ctx.fillStyle = '#e8c35a';
  ctx.beginPath();
  ctx.arc(x + 80 * s, y - altura - fundo * 0.5 - 22 * s, 8 * s, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(x + 79 * s, y - altura - fundo * 0.5 - 22 * s, 2 * s, 22 * s);
  const brilho = 0.18 + 0.05 * Math.sin(t * 3);
  ctx.fillStyle = `rgba(255, 220, 140, ${brilho})`;
  ctx.beginPath();
  ctx.moveTo(x + 72 * s, y - altura - fundo * 0.5 - 22 * s);
  ctx.lineTo(x + 88 * s, y - altura - fundo * 0.5 - 22 * s);
  ctx.lineTo(x + 104 * s, y - altura - 2 * s);
  ctx.lineTo(x + 56 * s, y - altura - 2 * s);
  ctx.closePath();
  ctx.fill();
}

export function desenharVidroSala(ctx) {
  ctx.fillStyle = 'rgba(170, 210, 255, 0.10)';
  ctx.strokeStyle = 'rgba(200, 230, 255, 0.45)';
  ctx.lineWidth = 2;
  // paredes laterais
  for (const [xa, xb] of [[SALA.esq, SALA.esq - 20], [SALA.dir, SALA.dir + 20]]) {
    ctx.beginPath();
    ctx.moveTo(xa, 60);
    ctx.lineTo(xb, 150);
    ctx.lineTo(xb, SALA.frente);
    ctx.lineTo(xa, SALA.fundo);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // frente com a porta aberta no meio
  for (const [a, b] of [[SALA.esq - 20, SALA.portaEsq], [SALA.portaDir, SALA.dir + 20]]) {
    ctx.fillRect(a, 150, b - a, SALA.frente - 150);
    ctx.strokeRect(a, 150, b - a, SALA.frente - 150);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(a + 20, 150);
    ctx.lineTo(a + 50, 150);
    ctx.lineTo(a + 20, SALA.frente);
    ctx.lineTo(a, SALA.frente);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(170, 210, 255, 0.10)';
  }
  ctx.fillStyle = 'rgba(200, 230, 255, 0.5)';
  ctx.fillRect(SALA.esq - 20, 148, SALA.dir - SALA.esq + 40, 3);
}

// ------------------------------------------------------------------ robôs

const EMOCOES = ['normal', 'feliz', 'triste', 'dormindo', 'pensando', 'surpreso'];
export { EMOCOES };

/**
 * Desenha um robô com os pés em (r.x, r.y). Campos usados: cor, corEscura, simboloPeito, chefe,
 * emocao, olharX, olharY, antena, andando, digitando, segurandoTablet, deCostas, inclinacao,
 * selecionado, piscarAte.
 */
export function desenharRobo(ctx, r, t, reduzido) {
  const s = escalaEm(r.escalaY ?? r.y) * TAMANHO_ROBO * (r.chefe ? 1.2 : 1);
  const bob = reduzido ? 0 : Math.sin(t * (r.andando ? 9 : 2.2) + r.fase) * (r.andando ? 2.2 : 1.6) * s;
  const x = r.x;
  const y = r.y;

  // seleção e sombra (não quando está sentado atrás da mesa)
  if (r.selecionado && !r.levantado) {
    ctx.strokeStyle = 'rgba(255, 230, 120, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = -t * 20;
    ctx.beginPath();
    ctx.ellipse(x, y, 30 * s, 9 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (!r.levantado) {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x, y, 20 * s - bob * 0.4, 6 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(x, y - 10 * s + bob);
  ctx.rotate(r.inclinacao ?? 0);

  // jato de flutuação
  const jato = ctx.createRadialGradient(0, 0, 1, 0, 0, 14 * s);
  jato.addColorStop(0, r.antena + 'cc');
  jato.addColorStop(1, r.antena + '00');
  ctx.fillStyle = jato;
  ctx.beginPath();
  ctx.ellipse(0, 2 * s, 14 * s, 6 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = r.corEscura;
  ctx.beginPath();
  ctx.ellipse(0, -2 * s, 12 * s, 5 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // braços (atrás do corpo quando de costas)
  const balanco = r.andando && !reduzido ? Math.sin(t * 9 + r.fase) * 0.6 : 0;
  const digita = r.digitando && !reduzido ? Math.sin(t * 22 + r.fase) * 2.5 * s : 0;
  const desenharBraco = (lado) => {
    ctx.save();
    ctx.translate(lado * 19 * s, -40 * s);
    let ang = lado * 0.25 + balanco * lado;
    if (r.digitando) ang = lado * -0.9;
    if ((r.segurandoTablet || r.caneca) && lado === 1) ang = -0.95;
    if (r.gesticulando && lado === -1 && !reduzido) ang = -1.2 + Math.sin(t * 6) * 0.35;
    ctx.rotate(ang);
    ctx.fillStyle = r.corEscura;
    retanguloArredondado(ctx, -4 * s, 0, 8 * s, 22 * s + (lado === 1 ? digita : -digita), 4 * s);
    ctx.fill();
    ctx.fillStyle = r.cor;
    ctx.beginPath();
    ctx.arc(0, 22 * s + (lado === 1 ? digita : -digita), 5 * s, 0, Math.PI * 2);
    ctx.fill();
    if (r.segurandoTablet && lado === 1) {
      ctx.fillStyle = '#0b1020';
      retanguloArredondado(ctx, -9 * s, 18 * s, 18 * s, 13 * s, 2 * s);
      ctx.fill();
      ctx.fillStyle = r.antena;
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 8);
      ctx.fillRect(-6 * s, 21 * s, 12 * s, 7 * s);
      ctx.globalAlpha = 1;
    }
    if (r.caneca && lado === 1) {
      ctx.fillStyle = '#f2f2f2';
      retanguloArredondado(ctx, -6 * s, 17 * s, 12 * s, 12 * s, 2 * s);
      ctx.fill();
      ctx.fillStyle = '#8a5a3a';
      ctx.fillRect(-5 * s, 18 * s, 10 * s, 3 * s);
      if (!reduzido) {
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1.2 * s;
        ctx.beginPath();
        ctx.moveTo(0, 15 * s);
        ctx.quadraticCurveTo(Math.sin(t * 2 + r.fase) * 4 * s, 9 * s, Math.sin(t * 2 + r.fase + 1) * 2 * s, 3 * s);
        ctx.stroke();
      }
    }
    ctx.restore();
  };
  if (r.deCostas) {
    desenharBraco(-1);
    desenharBraco(1);
  }

  // corpo
  const corpo = ctx.createLinearGradient(-18 * s, 0, 18 * s, 0);
  corpo.addColorStop(0, r.cor);
  corpo.addColorStop(1, r.corEscura);
  ctx.fillStyle = corpo;
  retanguloArredondado(ctx, -17 * s, -46 * s, 34 * s, 38 * s, 10 * s);
  ctx.fill();
  if (!r.deCostas) {
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.beginPath();
    ctx.arc(0, -28 * s, 8.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = r.corEscura;
    ctx.font = `800 ${Math.round(10 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(r.simboloPeito, 0, -24.5 * s);
    if (r.chefe) {
      // gravata
      ctx.fillStyle = '#c0362c';
      ctx.beginPath();
      ctx.moveTo(-3 * s, -45 * s);
      ctx.lineTo(3 * s, -45 * s);
      ctx.lineTo(5 * s, -38 * s);
      ctx.lineTo(0, -36 * s);
      ctx.lineTo(-5 * s, -38 * s);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    for (let i = 0; i < 3; i++) ctx.fillRect(-9 * s, (-38 + i * 7) * s, 18 * s, 2.5 * s);
  }

  if (!r.deCostas) {
    desenharBraco(-1);
    desenharBraco(1);
  }

  // pescoço e cabeça
  ctx.fillStyle = r.corEscura;
  ctx.fillRect(-5 * s, -52 * s, 10 * s, 8 * s);
  const cabecaY = -84 * s;
  ctx.fillStyle = r.cor;
  retanguloArredondado(ctx, -22 * s, cabecaY, 44 * s, 33 * s, 11 * s);
  ctx.fill();
  // orelhas
  ctx.fillStyle = r.corEscura;
  ctx.fillRect(-25 * s, cabecaY + 11 * s, 4 * s, 11 * s);
  ctx.fillRect(21 * s, cabecaY + 11 * s, 4 * s, 11 * s);

  if (r.deCostas) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    retanguloArredondado(ctx, -14 * s, cabecaY + 7 * s, 28 * s, 18 * s, 6 * s);
    ctx.fill();
  } else {
    // rosto (tela)
    ctx.fillStyle = '#0a1222';
    retanguloArredondado(ctx, -17 * s, cabecaY + 5 * s, 34 * s, 23 * s, 8 * s);
    ctx.fill();
    desenharOlhos(ctx, r, t, s, cabecaY, reduzido);
  }

  // antena (coroa no chefe)
  ctx.strokeStyle = r.corEscura;
  ctx.lineWidth = 2.5 * s;
  const pulsoAntena = reduzido ? 1 : 0.65 + 0.35 * Math.sin(t * 5 + r.fase);
  if (r.chefe) {
    ctx.fillStyle = '#e8c35a';
    ctx.beginPath();
    ctx.moveTo(-12 * s, cabecaY + 1 * s);
    ctx.lineTo(-12 * s, cabecaY - 10 * s);
    ctx.lineTo(-6 * s, cabecaY - 4 * s);
    ctx.lineTo(0, cabecaY - 13 * s);
    ctx.lineTo(6 * s, cabecaY - 4 * s);
    ctx.lineTo(12 * s, cabecaY - 10 * s);
    ctx.lineTo(12 * s, cabecaY + 1 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = r.antena;
    ctx.globalAlpha = pulsoAntena;
    ctx.beginPath();
    ctx.arc(0, cabecaY - 9 * s, 2.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  } else {
    ctx.beginPath();
    ctx.moveTo(0, cabecaY);
    ctx.lineTo(0, cabecaY - 10 * s);
    ctx.stroke();
    const brilho = ctx.createRadialGradient(0, cabecaY - 12 * s, 0, 0, cabecaY - 12 * s, 9 * s);
    brilho.addColorStop(0, r.antena);
    brilho.addColorStop(1, r.antena + '00');
    ctx.globalAlpha = pulsoAntena;
    ctx.fillStyle = brilho;
    ctx.beginPath();
    ctx.arc(0, cabecaY - 12 * s, 9 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = r.antena;
    ctx.beginPath();
    ctx.arc(0, cabecaY - 12 * s, 3.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // "z z z" quando dorme
  if (r.emocao === 'dormindo' && !reduzido) {
    ctx.fillStyle = 'rgba(200, 220, 255, 0.85)';
    ctx.font = `700 ${Math.round(12 * s)}px system-ui, sans-serif`;
    for (let i = 0; i < 3; i++) {
      const k = ((t * 0.6 + i / 3) % 1);
      ctx.globalAlpha = 1 - k;
      ctx.fillText('z', x + (14 + k * 16) * s, y - (96 + k * 26) * s);
    }
    ctx.globalAlpha = 1;
  }
}

function desenharOlhos(ctx, r, t, s, cabecaY, reduzido) {
  const ox = (r.olharX ?? 0) * 4 * s;
  const oy = (r.olharY ?? 0) * 2.5 * s;
  const cy = cabecaY + 16 * s + oy;
  const piscando = !reduzido && ((t + r.fase * 3) % 4.2 < 0.12);
  ctx.fillStyle = r.olhoCor ?? '#7ff3ff';
  ctx.strokeStyle = r.olhoCor ?? '#7ff3ff';
  ctx.lineWidth = 2.2 * s;
  ctx.lineCap = 'round';
  for (const lado of [-1, 1]) {
    const ex = lado * 7.5 * s + ox;
    switch (r.emocao) {
      case 'feliz':
        ctx.beginPath();
        ctx.arc(ex, cy + 2 * s, 4 * s, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
        break;
      case 'triste':
        ctx.beginPath();
        ctx.moveTo(ex - 4 * s, cy - lado * 1.5 * s);
        ctx.lineTo(ex + 4 * s, cy + lado * 1.5 * s);
        ctx.stroke();
        ctx.fillRect(ex - 2 * s, cy + 1 * s, 4 * s, 3 * s);
        break;
      case 'dormindo':
        ctx.beginPath();
        ctx.moveTo(ex - 4 * s, cy + 1 * s);
        ctx.lineTo(ex + 4 * s, cy + 1 * s);
        ctx.stroke();
        break;
      case 'surpreso':
        ctx.beginPath();
        ctx.arc(ex, cy, 4.2 * s, 0, Math.PI * 2);
        ctx.stroke();
        break;
      default: {
        const h = piscando ? 1 * s : 7 * s;
        retanguloArredondado(ctx, ex - 3 * s, cy - h / 2, 6 * s, h, 3 * s);
        ctx.fill();
      }
    }
  }
  if (r.emocao === 'pensando' && !reduzido) {
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.35 + 0.65 * ((Math.sin(t * 6 - i) + 1) / 2);
      ctx.beginPath();
      ctx.arc((i - 1) * 4 * s, cabecaY + 25 * s, 1.3 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ balões, holograma e partículas

function quebrarTexto(ctx, texto, largura) {
  const linhas = [];
  for (const paragrafo of texto.split('\n')) {
    let atual = '';
    for (const palavra of paragrafo.split(' ')) {
      const teste = atual ? `${atual} ${palavra}` : palavra;
      if (ctx.measureText(teste).width > largura && atual) {
        linhas.push(atual);
        atual = palavra;
      } else atual = teste;
    }
    linhas.push(atual);
  }
  return linhas;
}

export function desenharBalao(ctx, r, t) {
  const f = r.fala;
  if (!f || f.ate < t) return;
  const s = escalaEm(r.escalaY ?? r.y) * TAMANHO_ROBO * (r.chefe ? 1.2 : 1);
  const entrada = Math.min(1, (t - f.desde) / 0.25);
  const saida = Math.min(1, (f.ate - t) / 0.3);
  const k = Math.min(entrada, saida);
  ctx.save();
  ctx.globalAlpha = k;
  ctx.font = '600 13px system-ui, sans-serif';
  const linhas = quebrarTexto(ctx, f.texto, 220);
  const w = Math.max(...linhas.map((l) => ctx.measureText(l).width)) + 20;
  const h = linhas.length * 17 + 12;
  let bx = r.x - w / 2 + (f.deslocX ?? 0);
  bx = Math.max(8, Math.min(LARGURA - w - 8, bx));
  const by = r.y - 108 * s - h - (1 - entrada) * 8;
  ctx.fillStyle = f.cor ?? 'rgba(255,255,255,0.96)';
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  retanguloArredondado(ctx, bx, by, w, h, 9);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(r.x - 7, by + h);
  ctx.lineTo(r.x + 7, by + h);
  ctx.lineTo(r.x, by + h + 9);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = f.corTexto ?? '#1c2430';
  ctx.textAlign = 'left';
  linhas.forEach((l, i) => ctx.fillText(l, bx + 10, by + 20 + i * 17));
  ctx.restore();
}

/** Holograma da reunião: gráfico do ativo, lista de verificação do chefe e o carimbo da decisão. */
export function desenharHolograma(ctx, reuniao, t, ativo) {
  if (!reuniao) return;
  const T = reuniao.tempos;
  const abrir = Math.min(1, (t - reuniao.desde - T.abrir) / 0.45);
  if (abrir <= 0) return;
  const fechar = Math.min(1, Math.max(0, (t - reuniao.desde - T.fechar) / 0.4));
  if (fechar >= 1) return;
  // fica acima do analista que está na reunião e à esquerda do chefe, sem cobrir nenhum dos dois
  const cx = 500;
  const w = 380 * easeOutBack(abrir);
  const h = 172 * abrir;
  const x = cx - w / 2;
  const y = 30;
  ctx.save();
  ctx.globalAlpha = Math.min(1, abrir * 1.2) * (1 - fechar);
  // feixe saindo da mesa
  const feixe = ctx.createLinearGradient(0, y + h, 0, 236);
  feixe.addColorStop(0, 'rgba(90, 230, 255, 0.0)');
  feixe.addColorStop(1, 'rgba(90, 230, 255, 0.22)');
  ctx.fillStyle = feixe;
  ctx.beginPath();
  ctx.moveTo(x + 30, y + h);
  ctx.lineTo(x + w - 30, y + h);
  ctx.lineTo(620, 236);
  ctx.lineTo(580, 236);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(10, 40, 70, 0.72)';
  ctx.strokeStyle = 'rgba(120, 235, 255, 0.85)';
  ctx.lineWidth = 1.5;
  retanguloArredondado(ctx, x, y, w, h, 10);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  // linhas de varredura
  ctx.fillStyle = 'rgba(120, 235, 255, 0.05)';
  for (let ly = y + ((t * 30) % 6); ly < y + h; ly += 6) ctx.fillRect(x, ly, w, 1);

  if (abrir >= 1) {
    const p = reuniao.proposta;
    ctx.fillStyle = '#bff6ff';
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${p.lado === 'compra' ? 'COMPRA' : 'VENDA'} ${ativo.simbolo} · ${p.motivo}`, x + 12, y + 20);

    // mini gráfico com a média 60 que o chefe usa
    const serie = ativo.historico.slice(-120);
    const gx = x + 12;
    const gy = y + 30;
    const gw = 130;
    const gh = 70;
    const min = Math.min(...serie);
    const max = Math.max(...serie);
    const faixa = max - min || 1;
    ctx.strokeStyle = 'rgba(120, 235, 255, 0.9)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    serie.forEach((v, i) => {
      const px = gx + (i / (serie.length - 1)) * gw;
      const py = gy + gh - ((v - min) / faixa) * gh;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.9)';
    ctx.beginPath();
    let comecou = false;
    const medias60 = ativo.medias[60].slice(-serie.length);
    serie.forEach((_, i) => {
      const m = medias60[i];
      if (m === null) return;
      const px = gx + (i / (serie.length - 1)) * gw;
      const py = gy + gh - ((m - min) / faixa) * gh;
      if (!comecou) {
        ctx.moveTo(px, py);
        comecou = true;
      } else ctx.lineTo(px, py);
    });
    ctx.stroke();
    // varredura do chefe passando pelo gráfico
    const vx = gx + ((t * 0.9) % 1) * gw;
    ctx.fillStyle = 'rgba(120, 235, 255, 0.25)';
    ctx.fillRect(vx - 2, gy, 4, gh);

    // lista de verificação, um item por vez
    ctx.font = '600 12px system-ui, sans-serif';
    reuniao.verificacao.itens.forEach((item, i) => {
      const aparece = reuniao.desde + T.itens + i * T.passo;
      if (t < aparece) return;
      const k = Math.min(1, (t - aparece) / 0.25);
      ctx.globalAlpha = k * (1 - fechar);
      ctx.fillStyle = item.ok ? '#3ddc84' : '#ff6b6b';
      ctx.fillText(item.ok ? '✔' : '✖', x + 152, y + 44 + i * 19);
      ctx.fillStyle = '#e6fbff';
      ctx.fillText(item.texto, x + 168, y + 44 + i * 19);
      ctx.globalAlpha = 1 - fechar;
    });

    // notas e carimbo
    const tNotas = reuniao.desde + T.notas;
    if (t >= tNotas) {
      ctx.fillStyle = '#bff6ff';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(
        reuniao.rodape ?? `analista ${Math.round(p.confianca * 100)}% · chefe ${Math.round(reuniao.verificacao.nota * 100)}% · juntos ${Math.round(reuniao.decisao.combinada * 100)}%`,
        x + 12,
        y + h - 14,
      );
    }
    const tCarimbo = reuniao.desde + T.carimbo;
    if (t >= tCarimbo) {
      const k = Math.min(1, (t - tCarimbo) / 0.3);
      const escala = 1.6 - 0.6 * easeOutBack(k);
      ctx.save();
      ctx.translate(x + 80, y + 70);
      ctx.rotate(-0.18);
      ctx.scale(escala, escala);
      ctx.globalAlpha = k * (1 - fechar);
      const cor = reuniao.decisao.aprovado ? '#3ddc84' : '#ff6b6b';
      ctx.strokeStyle = cor;
      ctx.fillStyle = cor;
      ctx.lineWidth = 3;
      ctx.font = '900 20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const texto = reuniao.decisao.aprovado ? 'APROVADO' : 'REPROVADO';
      const tw = ctx.measureText(texto).width + 20;
      retanguloArredondado(ctx, -tw / 2, -18, tw, 32, 6);
      ctx.stroke();
      ctx.fillText(texto, 0, 5);
      ctx.restore();
    }
  }
  ctx.restore();
}

export function easeOutBack(k) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2;
}

export function easeInOut(k) {
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
}

export function desenharParticulas(ctx, particulas) {
  for (const p of particulas) {
    const k = p.vida / p.vidaTotal;
    ctx.globalAlpha = Math.max(0, k);
    if (p.tipo === 'moeda') {
      ctx.fillStyle = '#ffd34d';
      ctx.strokeStyle = '#b8860b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 5 * Math.abs(Math.cos(p.giro)) + 1, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = p.cor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.raio * k + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
