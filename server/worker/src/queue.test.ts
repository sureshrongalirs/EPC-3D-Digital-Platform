import crypto from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { claimJobs, reclaimStalledJobs } from './queue.js';
import { createTestDb, type TestDbContext } from './testUtil/db.js';

async function insertQueuedModel(ctx: TestDbContext, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await ctx.db.knex('models').insert({
    id,
    name,
    source_format: 'fbx',
    size_bytes: 100,
    status: 'queued',
    current_revision: null,
    site_id: null,
    error: null,
    source_files: '[]',
  });
  return id;
}

describe('claimJobs (SELECT ... FOR UPDATE SKIP LOCKED semantics)', () => {
  let ctx: TestDbContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('two workers claiming from a shared queue of five jobs each process a disjoint set, and every job is claimed exactly once', async () => {
    ctx = await createTestDb();
    const ids = await Promise.all([1, 2, 3, 4, 5].map((n) => insertQueuedModel(ctx, `Model-${n}`)));

    const [batchA, batchB] = await Promise.all([claimJobs(ctx.db, 3), claimJobs(ctx.db, 3)]);
    const claimedIds = [...batchA, ...batchB].map((m) => m.id);

    expect(claimedIds).toHaveLength(5);
    expect(new Set(claimedIds).size).toBe(5); // no id claimed twice
    expect(new Set(claimedIds)).toEqual(new Set(ids));

    for (const model of [...batchA, ...batchB]) {
      expect(model.status).toBe('processing');
    }

    // Nothing left in the queue.
    const remaining = await claimJobs(ctx.db, 10);
    expect(remaining).toHaveLength(0);
  });

  it('claiming flips status to processing and stamps processing_started_at', async () => {
    ctx = await createTestDb();
    await insertQueuedModel(ctx, 'Solo');

    const [claimed] = await claimJobs(ctx.db, 1);
    expect(claimed!.status).toBe('processing');
    expect(claimed!.processing_started_at).not.toBeNull();
  });
});

describe('reclaimStalledJobs (crash-safety: a stuck processing row returns to queued)', () => {
  let ctx: TestDbContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('reclaims a job whose processing_started_at is older than the stall timeout', async () => {
    ctx = await createTestDb();
    const id = await insertQueuedModel(ctx, 'Killed mid-job');
    await claimJobs(ctx.db, 1);

    const staleTimestamp = new Date(Date.now() - 60_000).toISOString();
    await ctx.db.knex('models').where({ id }).update({ processing_started_at: staleTimestamp });

    const reclaimedCount = await reclaimStalledJobs(ctx.db, 10_000, silentLogger());

    const row = await ctx.db.knex('models').where({ id }).first();
    expect(reclaimedCount).toBe(1);
    expect(row.status).toBe('queued');
    expect(row.processing_started_at).toBeNull();
  });

  it('does not reclaim a job whose processing_started_at is still within the stall timeout', async () => {
    ctx = await createTestDb();
    const id = await insertQueuedModel(ctx, 'Still running');
    await claimJobs(ctx.db, 1);

    const reclaimedCount = await reclaimStalledJobs(ctx.db, 10_000, silentLogger());

    const row = await ctx.db.knex('models').where({ id }).first();
    expect(reclaimedCount).toBe(0);
    expect(row.status).toBe('processing');
  });
});

function silentLogger() {
  return { warn: () => {}, error: () => {}, info: () => {} } as unknown as import('pino').Logger;
}
