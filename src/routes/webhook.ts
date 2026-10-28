import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { logger } from '../logger.js';
import { processarSinal } from '../motor.js';

// POST /webhook/<token>
//
// O token no caminho é o que identifica (e autoriza) a estratégia: o TradingView não deixa pôr
// cabeçalho próprio no alerta. Trate a URL como senha. O corpo pode vir como JSON ou como texto
// com JSON dentro (o TradingView manda text/plain).

export const webhook = Router();

webhook.post(
  '/:token',
  rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }),
  express.text({ type: '*/*', limit: '8kb' }),
  async (req, res) => {
    const token = String(req.params.token ?? '');
    if (token.length < 20 || token.length > 100) return void res.status(404).json({ erro: 'não encontrado' });
    try {
      const r = await processarSinal(token, req.body, req.ip ?? null);
      if (r.status === 404) return void res.status(404).json({ erro: 'não encontrado' });
      res.status(r.status).json({ situacao: r.situacao, motivo: r.motivo, ordem: r.ordemId });
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'falha ao processar sinal');
      res.status(500).json({ erro: 'falha interna; o sinal não foi executado' });
    }
  },
);
