import 'dotenv/config';

import fsp from 'node:fs/promises';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { closeDatabase, initDatabase } from './db/index.js';
import { runMigrations } from './db/migrations.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await fsp.mkdir(config.modelsRawDir, { recursive: true });
  await fsp.mkdir(config.modelsArtifactsDir, { recursive: true });

  const db = await initDatabase(config.databaseUrl);
  await runMigrations(db);

  const app = createApp(db, config);
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, dialect: db.dialect }, 'plantscope api listening');
  });

  const shutdown = async (): Promise<void> => {
    server.close();
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
