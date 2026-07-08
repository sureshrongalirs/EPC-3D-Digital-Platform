import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, initDatabase, type Database } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';

export interface TestDbContext {
  db: Database;
  cleanup: () => Promise<void>;
}

/** Fresh temp-file SQLite database + migrations, for tests that only need the DB layer
 * (not a full Express app — see server/api's testUtil/testApp.ts for that). */
export async function createTestDb(): Promise<TestDbContext> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-shared-test-'));
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
