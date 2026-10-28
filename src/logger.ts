import { pino } from 'pino';

// Nada de chave de API, token de webhook ou senha nos logs, mesmo que algum objeto passe inteiro.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['*.apiKey', '*.secret', '*.password', '*.senha', '*.token', 'req.headers.cookie'],
    censor: '<redigido>',
  },
});
