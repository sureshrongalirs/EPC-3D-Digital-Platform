import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { closeDatabase, initDatabase, type Database } from './db/index.js';
import { runMigrations } from './db/migrations.js';
import { publishRevision } from './lib/publish.js';
import { resolveRotation } from './lib/rotationPrecedence.js';
import { createModel } from './repo/models.js';

/**
 * Task's fallback rule: run the full suite against SQLite (see the other *.test.ts files
 * in this package) and treat Postgres as a separate, Docker-gated integration suite. This
 * environment had no Docker daemon while writing it, so it's exercised here only when one
 * is actually available (e.g. GitHub Actions' ubuntu-latest runners, which ship Docker).
 */
function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!isDockerAvailable())('Postgres integration (testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    db = await initDatabase(container.getConnectionUri());
    await runMigrations(db);

    const config = loadConfig({
      DATA_DIR: path.join(os.tmpdir(), 'plantscope-pg-test'),
      DATABASE_URL: container.getConnectionUri(),
      MAX_UPLOAD_MB: '10',
      PORT: '0',
    } as NodeJS.ProcessEnv);
    app = createApp(db, config);
  }, 120_000);

  afterAll(async () => {
    await closeDatabase(db);
    await container.stop();
  });

  it('runs migrations and starts with an empty catalog', async () => {
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('creates a site and a model, and GET reflects both against real Postgres', async () => {
    const siteRes = await request(app).post('/api/sites').send({ name: 'PG Test Site', rotationDeg: 12 });
    expect(siteRes.status).toBe(201);

    const modelId = crypto.randomUUID();
    await createModel(db, {
      id: modelId,
      name: 'PG Model',
      sourceFormat: 'fbx',
      sizeBytes: 123,
      sourceFiles: [],
      siteId: siteRes.body.id,
    });

    const getRes = await request(app).get(`/api/models/${modelId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.siteId).toBe(siteRes.body.id);
  });

  it('resolves rotation via site inheritance against real Postgres', async () => {
    const siteRes = await request(app).post('/api/sites').send({ name: 'PG Rotation Site', rotationDeg: 33 });
    const resolved = await resolveRotation(db, siteRes.body.id, null);
    expect(resolved).toEqual({ rotationDeg: 33, rotationSource: 'site_inherited' });
  });

  it('publishRevision is atomic against real Postgres (mid-publish failure rolls back)', async () => {
    const modelId = crypto.randomUUID();
    await createModel(db, { id: modelId, name: 'PG Publish', sourceFormat: 'fbx', sizeBytes: 1, sourceFiles: [] });

    await expect(
      publishRevision(
        db,
        { modelId, revision: 1, artifactType: 'glb', artifactPath: 'x.glb' },
        {
          afterRevisionInsert: () => {
            throw new Error('simulated failure');
          },
        },
      ),
    ).rejects.toThrow('simulated failure');

    const model = await db.knex('models').where({ id: modelId }).first();
    expect(model.current_revision).toBeNull();
    const revisions = await db.knex('revisions').where({ model_id: modelId });
    expect(revisions).toHaveLength(0);
  });
});
