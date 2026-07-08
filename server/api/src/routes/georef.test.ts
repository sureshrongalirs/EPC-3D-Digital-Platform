import crypto from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createModel } from '@plantscope/server-shared';

import { createTestContext, type TestContext } from '../testUtil/testApp.js';

describe('rotation precedence (georef + sites HTTP routes)', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  async function createBareModel(siteId: string | null = null): Promise<string> {
    const id = crypto.randomUUID();
    await createModel(ctx.db, { id, name: 'M', sourceFormat: 'fbx', sizeBytes: 1, sourceFiles: [], siteId });
    return id;
  }

  it('(a) model with no site, no override -> default/0', async () => {
    ctx = await createTestContext();
    const modelId = await createBareModel(null);

    const res = await request(ctx.app).post(`/api/models/${modelId}/georef`).send({ anchorLat: 1, anchorLon: 2 });
    expect(res.status).toBe(200);
    expect(res.body.rotationDeg).toBe(0);
    expect(res.body.rotationSource).toBe('default');
  });

  it('(b) model with a site that has rotation_deg set, no model override -> inherits, site_inherited', async () => {
    ctx = await createTestContext();
    const siteRes = await request(ctx.app).post('/api/sites').send({ name: 'Site B', rotationDeg: 30 });
    const modelId = await createBareModel(siteRes.body.id);

    const res = await request(ctx.app).post(`/api/models/${modelId}/georef`).send({ anchorLat: 1, anchorLon: 2 });
    expect(res.body.rotationDeg).toBe(30);
    expect(res.body.rotationSource).toBe('site_inherited');
  });

  it('(c) model with its own georef override -> keeps it regardless of site', async () => {
    ctx = await createTestContext();
    const siteRes = await request(ctx.app).post('/api/sites').send({ name: 'Site C', rotationDeg: 30 });
    const modelId = await createBareModel(siteRes.body.id);

    const res = await request(ctx.app)
      .post(`/api/models/${modelId}/georef`)
      .send({ anchorLat: 1, anchorLon: 2, rotationDeg: 77 });
    expect(res.body.rotationDeg).toBe(77);
    expect(res.body.rotationSource).toBe('model_override');

    // Still overridden after a GET, independent of the site's own value.
    const getRes = await request(ctx.app).get(`/api/models/${modelId}/georef`);
    expect(getRes.body.rotationDeg).toBe(77);
    expect(getRes.body.rotationSource).toBe('model_override');
  });

  it('(d) PATCH a site rotation -> GET on a previously-inherited model reflects the new value', async () => {
    ctx = await createTestContext();
    const siteRes = await request(ctx.app).post('/api/sites').send({ name: 'Site D', rotationDeg: 10 });
    const siteId = siteRes.body.id as string;
    const modelId = await createBareModel(siteId);
    await request(ctx.app).post(`/api/models/${modelId}/georef`).send({ anchorLat: 1, anchorLon: 2 });

    const patchRes = await request(ctx.app).patch(`/api/sites/${siteId}`).send({ rotationDeg: 55 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.affectedModelsCount).toBe(1);

    const getRes = await request(ctx.app).get(`/api/models/${modelId}/georef`);
    expect(getRes.body.rotationDeg).toBe(55);
    expect(getRes.body.rotationSource).toBe('site_inherited');
  });

  it("(d-cont) PATCH a site's rotation does NOT touch a model_override'd model at the same site", async () => {
    ctx = await createTestContext();
    const siteRes = await request(ctx.app).post('/api/sites').send({ name: 'Site D2', rotationDeg: 10 });
    const siteId = siteRes.body.id as string;
    const overriddenModelId = await createBareModel(siteId);
    await request(ctx.app)
      .post(`/api/models/${overriddenModelId}/georef`)
      .send({ anchorLat: 1, anchorLon: 2, rotationDeg: 123 });

    const patchRes = await request(ctx.app).patch(`/api/sites/${siteId}`).send({ rotationDeg: 55 });
    expect(patchRes.body.affectedModelsCount).toBe(0); // the overridden model is not "affected"

    const getRes = await request(ctx.app).get(`/api/models/${overriddenModelId}/georef`);
    expect(getRes.body.rotationDeg).toBe(123);
    expect(getRes.body.rotationSource).toBe('model_override');
  });

  it('(e) georef/reset on an overridden model -> falls back to current site value', async () => {
    ctx = await createTestContext();
    const siteRes = await request(ctx.app).post('/api/sites').send({ name: 'Site E', rotationDeg: 15 });
    const modelId = await createBareModel(siteRes.body.id);
    await request(ctx.app).post(`/api/models/${modelId}/georef`).send({ anchorLat: 1, anchorLon: 2, rotationDeg: 99 });

    const resetRes = await request(ctx.app).post(`/api/models/${modelId}/georef/reset`);
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.rotationDeg).toBe(15);
    expect(resetRes.body.rotationSource).toBe('site_inherited');
  });

  it('(e-cont) georef/reset on an overridden model with no site -> falls back to default/0', async () => {
    ctx = await createTestContext();
    const modelId = await createBareModel(null);
    await request(ctx.app).post(`/api/models/${modelId}/georef`).send({ anchorLat: 1, anchorLon: 2, rotationDeg: 99 });

    const resetRes = await request(ctx.app).post(`/api/models/${modelId}/georef/reset`);
    expect(resetRes.body.rotationDeg).toBe(0);
    expect(resetRes.body.rotationSource).toBe('default');
  });
});
