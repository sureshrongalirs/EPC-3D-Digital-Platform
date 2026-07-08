import 'dotenv/config';

import fsp from 'node:fs/promises';

import { closeDatabase, initDatabase, runMigrations } from '@plantscope/server-shared';

import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { startWorkerLoop } from './runner.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await fsp.mkdir(config.modelsRawDir, { recursive: true });
  await fsp.mkdir(config.modelsArtifactsDir, { recursive: true });

  const db = await initDatabase(config.databaseUrl);
  // Idempotent (schema_migrations-tracked): harmless if server/api already ran migrations
  // first, and necessary if the worker container happens to start before it.
  await runMigrations(db);

  logger.info(
    { parallelism: config.parallelism, dialect: db.dialect },
    'plantscope worker starting',
  );
  const handle = startWorkerLoop(db, config, logger);

  const shutdown = async (): Promise<void> => {
    await handle.stop();
    await closeDatabase(db);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
