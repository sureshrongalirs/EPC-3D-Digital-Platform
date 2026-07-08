import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';

import type { Database } from '@plantscope/server-shared';

import type { Config } from './config.js';
import { errorHandler, notFoundHandler } from './lib/problem.js';
import { logger } from './logger.js';
import { createComponentsRouter } from './routes/components.js';
import { createFilesRouter } from './routes/files.js';
import { createGeorefRouter } from './routes/georef.js';
import { createHealthzRouter } from './routes/healthz.js';
import { createModelsRouter } from './routes/models.js';
import { createSitesRouter } from './routes/sites.js';
import { createZonesRouter } from './routes/zones.js';

export function createApp(db: Database, config: Config): Express {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use(express.json());

  app.use('/api', createModelsRouter(db, config));
  app.use('/api', createComponentsRouter(db));
  app.use('/api', createZonesRouter(db));
  app.use('/api', createGeorefRouter(db));
  app.use('/api', createSitesRouter(db));
  app.use(createFilesRouter(config));
  app.use(createHealthzRouter());

  app.use(notFoundHandler);
  // Error middleware must be registered last, after every route.
  app.use(errorHandler);

  return app;
}
