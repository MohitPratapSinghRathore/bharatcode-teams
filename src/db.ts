import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Run `fn` in a transaction; it commits when `fn` resolves and rolls back when it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

// Parse int8/numeric as JS numbers (amounts and counters stay far below 2^53) and keep `date`
// as a YYYY-MM-DD string so it is never shifted by the server's local time zone.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createPgDb(connectionString: string, max: number): Db {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- implements the generic interface
    async query<T>(text: string, params?: readonly unknown[]) {
      const res = await pool.query(text, params as unknown[] | undefined);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q: Queryable = {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- implements the generic interface
          async query<R>(text: string, params?: readonly unknown[]) {
            const res = await client.query(text, params as unknown[] | undefined);
            return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
          },
        };
        const result = await fn(q);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Apply pending migrations in filename order, each in its own transaction, under an advisory lock. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  const lock = "SELECT pg_advisory_xact_lock(hashtext('bharatcode-teams-migrations'))";
  // Create the bookkeeping table under the lock too: concurrent CREATE ... IF NOT EXISTS can race.
  await db.tx(async (q) => {
    await q.query(lock);
    await q.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
  });
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    const didApply = await db.tx(async (q) => {
      await q.query(lock);
      const done = await q.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount > 0) return false;
      await q.query(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      return true;
    });
    if (didApply) applied.push(file);
  }
  return applied;
}

// Values from different drivers (pg parses int8 to number; others may give string/bigint).
export function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint' || typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new TypeError(`Expected a number from the database, got ${typeof value}`);
}

export function date(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new TypeError('Expected a timestamp from the database');
}

export function dateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new TypeError(`Expected text from the database, got ${typeof value}`);
}

export function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}
