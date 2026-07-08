import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, initDatabase, runMigrations, type Database } from '@plantscope/server-shared';

export interface TestDbContext {
  db: Database;
  cleanup: () => Promise<void>;
}

/** Fresh temp-file SQLite database + migrations -- mirrors server/shared's own
 * testUtil/db.ts (not exported from the package's public API, so the worker keeps its own
 * copy rather than reaching into server-shared's internals). */
export async function createTestDb(): Promise<TestDbContext> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-worker-test-'));
  const db = await initDatabase(path.join(dataDir, 'test.sqlite3'));
  await runMigrations(db);

  return {
    db,
    cleanup: async () => {
      await closeDatabase(db);
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}
