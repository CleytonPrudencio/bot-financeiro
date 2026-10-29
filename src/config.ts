// Configuração lida do ambiente uma vez, na subida. Falta de variável obrigatória derruba o
// processo na hora, com a mensagem de qual falta, em vez de falhar no meio de uma ordem.

function obrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`defina ${nome} no .env`);
  return valor;
}

function inteiro(nome: string, padrao: number): number {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto === '') return padrao;
  const n = Number(bruto);
  if (!Number.isFinite(n)) throw new Error(`${nome} precisa ser número`);
  return n;
}

export const config = {
  porta: inteiro('PORT', 3000),
  producao: process.env.NODE_ENV === 'production',
  databaseUrl: obrigatoria('DATABASE_URL'),
  // assina o cookie de sessão do painel
  segredoSessao: obrigatoria('BOT_SESSION_SECRET'),
  // cifra as chaves de API das exchanges guardadas no banco
  chaveCifra: obrigatoria('BOT_ENCRYPTION_KEY'),
  // Primeira das três chaves do dinheiro real. Sem ela "true", nenhuma ordem real sai,
  // não importa o que estiver ligado no painel.
  realLiberadoNoServidor: process.env.BOT_LIVE_ENABLED === 'true',
  // endereço público, usado para montar a URL do webhook mostrada no painel
  urlPublica: process.env.BOT_PUBLIC_URL ?? 'http://localhost:3000',
  // Atrás do Caddy o IP real vem no X-Forwarded-For. 1 = confia em um proxy.
  proxiesConfiaveis: inteiro('BOT_TRUST_PROXY', 1),
  fuso: 'America/Sao_Paulo',
  // serviço de previsão do Kronos (container bot-kronos); sem ele, o bot segue sem previsão
  kronosUrl: process.env.KRONOS_URL || null,
} as const;
