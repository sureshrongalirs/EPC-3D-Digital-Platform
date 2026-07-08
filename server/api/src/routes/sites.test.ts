import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createTestContext, type TestContext } from '../testUtil/testApp.js';

describe('sites routes', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('create -> list -> get', async () => {
    ctx = await createTestContext();

    const createRes = await request(ctx.app).post('/api/sites').send({ name: 'Refinery North' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.rotationDeg).toBeNull();

    const listRes = await request(ctx.app).get('/api/sites');
    expect(listRes.body).toHaveLength(1);

    const getRes = await request(ctx.app).get(`/api/sites/${createRes.body.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.name).toBe('Refinery North');
  });

  it('404s for an unknown site id', async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app).get('/api/sites/does-not-exist');
    expect(res.status).toBe(404);
  });
});
