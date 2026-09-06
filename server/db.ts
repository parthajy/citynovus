// One tiny interface over two Postgres flavours: a real one (DATABASE_URL, e.g. DigitalOcean
// Managed Postgres) and PGlite, Postgres compiled to WASM, for zero-setup local runs.
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface Queryable { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> }
export interface DB extends Queryable { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>; close(): Promise<void> }

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(path.join(here, 'schema.sql'), 'utf8');

export async function openDb(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  let db: DB;
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, ssl: /sslmode=require|ondigitalocean/.test(url) ? { rejectUnauthorized: false } : undefined });
    const q = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Queryable => ({ async query(sql, params = []) { return (await c.query(sql, params)).rows as never; } });
    db = {
      ...q(pool),
      async tx(fn) {
        const client = await pool.connect();
        try { await client.query('begin'); const r = await fn(q(client)); await client.query('commit'); return r; }
        catch (e) { await client.query('rollback'); throw e; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
    console.log('db: postgres');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = path.join(process.env.DATA_DIR ?? path.join(here, '..', 'data'), 'pglite');
    mkdirSync(dir, { recursive: true });
    const lite = new PGlite(dir);
    await lite.waitReady;
    const q = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Queryable => ({ async query(sql, params = []) { return (await c.query(sql, params)).rows as never; } });
    db = {
      ...q(lite),
      tx: (fn) => lite.transaction((t) => fn(q(t))),
      close: () => lite.close(),
    };
    console.log(`db: pglite at ${dir}`);
  }
  for (const stmt of SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  return db;
}
