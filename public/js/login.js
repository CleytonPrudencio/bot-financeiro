// Tela de login com fundo animado: um gráfico de mercado que corre devagar, grade e partículas.

import { api, campo, h, icone, lerForm, marca, reduzido, tentar } from './base.js';

function fundoAnimado(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 0;
  let hh = 0;
  let raf = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const velas = [];
  let preco = 100;
  const particulas = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), v: 0.00015 + Math.random() * 0.0004, r: 0.6 + Math.random() * 1.6 }));

  function nova() {
    const abre = preco;
    preco *= 1 + (Math.random() - 0.48) * 0.035;
    const fecha = preco;
    velas.push({ abre, fecha, max: Math.max(abre, fecha) * (1 + Math.random() * 0.012), min: Math.min(abre, fecha) * (1 - Math.random() * 0.012) });
    if (velas.length > 90) velas.shift();
  }
  for (let i = 0; i < 90; i++) nova();

  function tamanho() {
    w = canvas.clientWidth;
    hh = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = hh * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  let deslize = 0;
  let ultimo = performance.now();
  function quadro(agora) {
    const dt = Math.min(0.05, (agora - ultimo) / 1000);
    ultimo = agora;
    deslize += dt * 18;
    const larg = 22;
    if (deslize >= larg) {
      deslize -= larg;
      nova();
    }
    ctx.clearRect(0, 0, w, hh);
    // grade
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
    ctx.lineWidth = 1;
    for (let gx = -(deslize % 44); gx < w; gx += 44) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, hh);
      ctx.stroke();
    }
    for (let gy = 0; gy < hh; gy += 44) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }
    // velas
    const max = Math.max(...velas.map((v) => v.max));
    const min = Math.min(...velas.map((v) => v.min));
    const y = (v) => hh * 0.82 - ((v - min) / (max - min || 1)) * hh * 0.5;
    const n = velas.length;
    ctx.globalAlpha = 0.5;
    velas.forEach((v, i) => {
      const x = w - (n - i) * larg - deslize + larg;
      if (x < -larg) return;
      const sobe = v.fecha >= v.abre;
      ctx.strokeStyle = ctx.fillStyle = sobe ? 'rgba(34, 197, 94, 0.55)' : 'rgba(239, 68, 68, 0.5)';
      ctx.beginPath();
      ctx.moveTo(x, y(v.max));
      ctx.lineTo(x, y(v.min));
      ctx.stroke();
      const topo = y(Math.max(v.abre, v.fecha));
      ctx.fillRect(x - 6, topo, 12, Math.max(2, y(Math.min(v.abre, v.fecha)) - topo));
    });
    // linha de média com brilho
    ctx.globalAlpha = 1;
    ctx.beginPath();
    velas.forEach((v, i) => {
      const ini = Math.max(0, i - 8);
      const m = velas.slice(ini, i + 1).reduce((t, c) => t + c.fecha, 0) / (i + 1 - ini);
      const x = w - (n - i) * larg - deslize + larg;
      if (i === 0) ctx.moveTo(x, y(m));
      else ctx.lineTo(x, y(m));
    });
    ctx.shadowColor = 'rgba(59, 130, 246, 0.9)';
    ctx.shadowBlur = 16;
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.9)';
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.shadowBlur = 0;
    // partículas
    for (const p of particulas) {
      p.y -= p.v * dt * 60;
      if (p.y < -0.02) p.y = 1.02;
      ctx.fillStyle = 'rgba(147, 197, 253, 0.5)';
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * hh, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (canvas.isConnected) raf = requestAnimationFrame(quadro);
  }

  tamanho();
  window.addEventListener('resize', tamanho);
  if (reduzido()) quadro(performance.now());
  else raf = requestAnimationFrame(quadro);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', tamanho);
  };
}

export function telaLogin(raiz, aoEntrar) {
  const canvas = h('canvas', { class: 'login-fundo', 'aria-hidden': 'true' });
  const botao = h('button', { class: 'botao botao-largo', type: 'submit' }, h('span', {}, 'Entrar'), icone('seta'));
  const form = h(
    'form',
    {
      class: 'login-form',
      onsubmit: async (ev) => {
        ev.preventDefault();
        botao.disabled = true;
        botao.classList.add('carregando');
        const r = await tentar(() => api('POST', '/login', lerForm(form)));
        botao.disabled = false;
        botao.classList.remove('carregando');
        if (r) {
          parar();
          aoEntrar();
        } else {
          cartao.classList.add('tremer');
          setTimeout(() => cartao.classList.remove('tremer'), 500);
        }
      },
    },
    campo('E-mail', { name: 'email', type: 'email', autocomplete: 'username', required: true, placeholder: 'voce@empresa.com' }),
    campo('Senha', { name: 'senha', type: 'password', autocomplete: 'current-password', required: true, placeholder: '••••••••' }),
    botao,
  );
  const cartao = h(
    'div',
    { class: 'login-cartao' },
    h('div', { class: 'login-marca' }, marca(), h('div', {}, h('strong', {}, 'Bot Financeiro'), h('span', {}, 'Mesa de operações automatizada'))),
    h('h1', {}, 'Bem-vindo de volta'),
    h('p', { class: 'suave' }, 'Entre para acompanhar estratégias, ordens e o parecer das IAs.'),
    form,
    h('p', { class: 'login-rodape' }, icone('escudo'), 'Sessão cifrada · dinheiro real só com três chaves ligadas'),
  );
  raiz.replaceChildren(h('div', { class: 'login' }, canvas, h('div', { class: 'login-brilho' }), cartao));
  const parar = fundoAnimado(canvas);
  form.querySelector('input')?.focus();
}
