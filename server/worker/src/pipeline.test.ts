import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ModelRow } from '@plantscope/server-shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { Config } from './config.js';
import { processJob } from './pipeline.js';
import { createTestDb, type TestDbContext } from './testUtil/db.js';

const GLB_MAGIC_HEADER = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00]);

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger() } as unknown as import('pino').Logger;
}

async function makeConfig(dataDir: string): Promise<Config> {
  return {
    dataDir,
    modelsRawDir: path.join(dataDir, 'models', 'raw'),
    modelsArtifactsDir: path.join(dataDir, 'models', 'artifacts'),
    databaseUrl: '',
    parallelism: 2,
    stallTimeoutMs: 60_000,
    largeJobMb: 250,
    sizeThresholdMb: 100,
    pollIntervalMs: 1000,
  };
}

describe('processJob', () => {
  let ctx: TestDbContext;
  let dataDir: string;

  afterEach(async () => {
    await ctx?.cleanup();
    if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('a GLB passthrough job publishes a revision via the shared publishRevision()', async () => {
    ctx = await createTestDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-worker-pipeline-'));
    const config = await makeConfig(dataDir);

    const modelId = crypto.randomUUID();
    const rawPath = path.join(config.modelsRawDir, modelId, 'model.glb');
    await fsp.mkdir(path.dirname(rawPath), { recursive: true });
    await fsp.writeFile(rawPath, GLB_MAGIC_HEADER);

    const sourceFiles = [{ kind: 'other', path: `models/raw/${modelId}/model.glb`, originalName: 'model.glb' }];
    await ctx.db.knex('models').insert({
      id: modelId,
      name: 'GLB model',
      source_format: 'glb',
      size_bytes: GLB_MAGIC_HEADER.length,
      status: 'queued',
      current_revision: null,
      site_id: null,
      error: null,
      source_files: JSON.stringify(sourceFiles),
    });
    const model = (await ctx.db.knex('models').where({ id: modelId }).first()) as ModelRow;

    await processJob(ctx.db, config, silentLogger(), model);

    const updated = await ctx.db.knex('models').where({ id: modelId }).first();
    expect(updated.status).toBe('ready');
    expect(updated.current_revision).toBe(1);

    const revisions = await ctx.db.knex('revisions').where({ model_id: modelId });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ artifact_type: 'glb' });
  });

  it('an unrecognized source format fails the job without ever flipping current_revision (reuses publishRevision atomicity guarantee)', async () => {
    ctx = await createTestDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-worker-pipeline-'));
    const config = await makeConfig(dataDir);

    const modelId = crypto.randomUUID();
    const rawPath = path.join(config.modelsRawDir, modelId, 'model.unknown');
    await fsp.mkdir(path.dirname(rawPath), { recursive: true });
    await fsp.writeFile(rawPath, Buffer.from('not a real file'));

    const sourceFiles = [{ kind: 'other', path: `models/raw/${modelId}/model.unknown`, originalName: 'model.unknown' }];
    await ctx.db.knex('models').insert({
      id: modelId,
      name: 'Unknown model',
      source_format: 'unknown',
      size_bytes: 10,
      status: 'queued',
      current_revision: null,
      site_id: null,
      error: null,
      source_files: JSON.stringify(sourceFiles),
    });
    const model = (await ctx.db.knex('models').where({ id: modelId }).first()) as ModelRow;

    await expect(processJob(ctx.db, config, silentLogger(), model)).rejects.toThrow(/format adapter/i);

    // processJob itself only throws -- the runner is what flips status to 'failed' -- but
    // regardless of who catches it, current_revision must never move off null and no
    // revision row must exist, exactly like the Phase 3 publish atomicity test.
    const updated = await ctx.db.knex('models').where({ id: modelId }).first();
    expect(updated.current_revision).toBeNull();
    const revisions = await ctx.db.knex('revisions').where({ model_id: modelId });
    expect(revisions).toHaveLength(0);
  });
});
