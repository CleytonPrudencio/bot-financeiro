// Aplica o tema salvo antes de a página pintar (sem piscar). Escuro é o padrão.
try {
  if (localStorage.getItem('tema') === 'claro') document.documentElement.dataset.tema = 'claro';
} catch {
  // armazenamento bloqueado: fica o padrão
}
