import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { pool } from './db.js';
import { logger } from './logger.js';
import { api } from './routes/api.js';
import { webhook } from './routes/webhook.js';
import { ponte } from './routes/ponte.js';

const iniciadoEm = new Date().toISOString();
const pastaPublica = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function criarApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.proxiesConfiaveis);

  app.use(
    pinoHttp({
      logger,
      // o token do webhook vai no caminho: no log, só o começo dele
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url.replace(/^\/webhook\/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]*/, '/webhook/$1…'),
        }),
      },
      // a ponte MT5 sincroniza a cada 1 a 2 s: só os erros dela vão para o log
      autoLogging: { ignore: (req) => req.url === '/saude' || req.url === '/ponte/sincronizar' },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      strictTransportSecurity: config.producao,
    }),
  );

  // Saúde: o deploy confere este endereço. No navegador mostra texto; para o curl, JSON.
  app.get('/saude', async (_req, res) => {
    let banco = 'ok';
    try {
      await pool.query('select 1');
    } catch {
      banco = 'fora';
    }
    res.status(banco === 'ok' ? 200 : 503).json({ ok: banco === 'ok', banco, iniciado_em: iniciadoEm });
  });

  app.use('/webhook', webhook);
  app.use('/ponte', ponte);
  app.use('/api', express.json({ limit: '32kb' }), cookieParser(), api);
  // HTML, JS e CSS revalidam a cada carga (ETag): depois de um deploy, nenhum módulo antigo fica
  // misturado com um novo. As fontes não mudam e ficam um ano.
  app.use(
    express.static(pastaPublica, {
      index: 'index.html',
      setHeaders: (res, arquivo) => {
        res.setHeader('cache-control', arquivo.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ erro: 'não encontrado' });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) logger.error({ err, url: req.originalUrl.split('?')[0] }, 'erro na requisição');
    res.status(status).json({ erro: status >= 500 ? 'erro interno' : (err as Error).message });
  });

  return app;
}
