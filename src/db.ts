import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// numeric do Postgres volta como string por padrão; aqui vira number (os valores do robô cabem
// com folga na precisão do double)
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));
// bigint[] (ids de conectores de IA) também vira number[]
// (os ids de tipo de array não estão no enum dos tipos do pg: 1009 = text[], 1016 = int8[])
const lerListaTexto = pg.types.getTypeParser(1009 as never) as (v: string) => string[];
pg.types.setTypeParser(1016 as never, (v: string) => lerListaTexto(v).map(Number));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await pool.query<T>(sql, params);
  return r.rows;
}

export async function umOuNada<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const linhas = await query<T>(sql, params);
  return linhas[0];
}

/** Roda `fn` numa transação; desfaz tudo se der erro. */
export async function transacao<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

const pastaMigracoes = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Aplica, em ordem, os arquivos de `migrations/` que ainda não rodaram. Cada um numa transação.
 * Migração já aplicada não se edita: cria-se a próxima (002_..., 003_...).
 */
export async function migrar(): Promise<void> {
  await query(`create table if not exists schema_migrations (
    nome text primary key,
    aplicada_em timestamptz not null default now()
  )`);
  const feitas = new Set((await query<{ nome: string }>('select nome from schema_migrations')).map((r) => r.nome));
  const arquivos = (await readdir(pastaMigracoes)).filter((f) => f.endsWith('.sql')).sort();
  for (const arquivo of arquivos) {
    if (feitas.has(arquivo)) continue;
    const sql = await readFile(path.join(pastaMigracoes, arquivo), 'utf8');
    await transacao(async (c) => {
      await c.query(sql);
      await c.query('insert into schema_migrations (nome) values ($1)', [arquivo]);
    });
    logger.info({ arquivo }, 'migração aplicada');
  }
}
