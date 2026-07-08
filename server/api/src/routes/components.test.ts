import crypto from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createTestContext, type TestContext } from '../testUtil/testApp.js';

describe('components route', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('GET /api/components/{key}?model={id} returns full joined props from a fixture row', async () => {
    ctx = await createTestContext();
    const modelId = crypto.randomUUID();
    await ctx.db.knex('models').insert({
      id: modelId,
      name: 'M',
      source_format: 'fbx',
      size_bytes: 1,
      status: 'ready',
      source_files: '[]',
    });
    await ctx.db.knex('components').insert({
      model_id: modelId,
      revision: 1,
      linkage_key: 'LINK-1',
      moniker: 'P-101A',
      category: 'Pump',
      props: JSON.stringify({ manufacturer: 'Acme', ratedFlowLpm: 500 }),
      bbox_min: JSON.stringify([0, 0, 0]),
      bbox_max: JSON.stringify([1, 1, 1]),
    });

    const res = await request(ctx.app).get(`/api/components/LINK-1?model=${modelId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      modelId,
      linkageKey: 'LINK-1',
      moniker: 'P-101A',
      category: 'Pump',
      props: { manufacturer: 'Acme', ratedFlowLpm: 500 },
      bboxMin: [0, 0, 0],
      bboxMax: [1, 1, 1],
    });
  });

  it('404s for an unknown linkage key', async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app).get('/api/components/NOPE?model=does-not-exist');
    expect(res.status).toBe(404);
  });

  it('400s when ?model= is missing', async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app).get('/api/components/LINK-1');
    expect(res.status).toBe(400);
  });
});
