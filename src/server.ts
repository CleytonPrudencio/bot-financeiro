import { criarApp } from './app.js';
import { config } from './config.js';
import { migrar, pool } from './db.js';
import { logger } from './logger.js';

await migrar();

const servidor = criarApp().listen(config.porta, () => {
  logger.info(
    { porta: config.porta, dinheiro_real: config.realLiberadoNoServidor ? 'LIBERADO no servidor' : 'desligado' },
    'robô no ar',
  );
});

function desligar(sinal: string) {
  logger.info({ sinal }, 'desligando');
  servidor.close(() => {
    void pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => desligar('SIGTERM'));
process.on('SIGINT', () => desligar('SIGINT'));
