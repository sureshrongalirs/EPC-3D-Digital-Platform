import crypto from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createModel } from '../repo/models.js';
import { createTestDb, type TestDbContext } from '../testUtil/db.js';
import { publishRevision } from './publish.js';

describe('publishRevision atomicity', () => {
  let ctx: TestDbContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('a failure mid-publish leaves current_revision (and the revision row) unchanged', async () => {
    ctx = await createTestDb();
    const modelId = crypto.randomUUID();
    await createModel(ctx.db, { id: modelId, name: 'Test', sourceFormat: 'fbx', sizeBytes: 100, sourceFiles: [] });

    await expect(
      publishRevision(
        ctx.db,
        { modelId, revision: 1, artifactType: 'glb', artifactPath: 'x.glb' },
        {
          afterRevisionInsert: () => {
            throw new Error('simulated failure');
          },
        },
      ),
    ).rejects.toThrow('simulated failure');

    const model = await ctx.db.knex('models').where({ id: modelId }).first();
    expect(model.current_revision).toBeNull();
    expect(model.status).toBe('queued');

    // The revision insert (the first statement) rolled back too — not just the second one.
    const revisions = await ctx.db.knex('revisions').where({ model_id: modelId });
    expect(revisions).toHaveLength(0);
  });

  it('a successful publish writes the revision and flips current_revision atomically', async () => {
    ctx = await createTestDb();
    const modelId = crypto.randomUUID();
    await createModel(ctx.db, { id: modelId, name: 'Test', sourceFormat: 'fbx', sizeBytes: 100, sourceFiles: [] });

    await publishRevision(ctx.db, { modelId, revision: 1, artifactType: 'glb', artifactPath: 'x.glb' });

    const model = await ctx.db.knex('models').where({ id: modelId }).first();
    expect(model.current_revision).toBe(1);
    expect(model.status).toBe('ready');

    const revisions = await ctx.db.knex('revisions').where({ model_id: modelId });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ artifact_type: 'glb', artifact_path: 'x.glb' });
  });
});
