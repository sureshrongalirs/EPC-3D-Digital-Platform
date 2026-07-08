import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Express } from 'express';

import { createApp } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { closeDatabase, initDatabase, type Database } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';

export interface TestContext {
  app: Express;
  db: Database;
  config: Config;
  cleanup: () => Promise<void>;
}

/** Fresh temp-dir + fresh SQLite file per test context — full isolation, no shared state. */
export async function createTestContext(): Promise<TestContext> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-api-test-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    DATABASE_URL: path.join(dataDir, 'test.sqlite3'),
    MAX_UPLOAD_MB: '1024',
    PORT: '0',
  } as NodeJS.ProcessEnv);

  await fsp.mkdir(config.modelsRawDir, { recursive: true });
  await fsp.mkdir(config.modelsArtifactsDir, { recursive: true });

  const db = await initDatabase(config.databaseUrl);
  await runMigrations(db);

  const app = createApp(db, config);

  return {
    app,
    db,
    config,
    cleanup: async () => {
      await closeDatabase(db);
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}
