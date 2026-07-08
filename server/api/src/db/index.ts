import knexFactory, { type Knex } from 'knex';

export type Dialect = 'pg' | 'sqlite3';

export interface Database {
  knex: Knex;
  dialect: Dialect;
}

function isPostgresUrl(databaseUrl: string): boolean {
  return databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://');
}

/**
 * One storage interface behind two adapters: Postgres (`pg`) for real deployments, a
 * bundled SQLite adapter (`better-sqlite3`) for local dev/tests with no external service.
 * Callers only ever see `Database` — dialect-specific behavior is confined to this file
 * and db/migrations.ts.
 */
export function createDatabase(databaseUrl: string): Database {
  if (isPostgresUrl(databaseUrl)) {
    const knex = knexFactory({
      client: 'pg',
      connection: databaseUrl,
      pool: { min: 0, max: 10 },
    });
    return { knex, dialect: 'pg' };
  }

  const knex = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: databaseUrl },
    useNullAsDefault: true,
  });
  return { knex, dialect: 'sqlite3' };
}

export async function initDatabase(databaseUrl: string): Promise<Database> {
  const db = createDatabase(databaseUrl);
  if (db.dialect === 'sqlite3') {
    // Off by default per-connection in SQLite; our FKs (site_id, model_id, zone_id, ...)
    // rely on enforcement.
    await db.knex.raw('PRAGMA foreign_keys = ON');
  }
  return db;
}

export async function closeDatabase(db: Database): Promise<void> {
  await db.knex.destroy();
}
