import fsp from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { accessBuffer, fakeFbxTextBuffer, fbxBuffer, glbBuffer, llhTextBuffer } from '../testUtil/fixtures.js';
import { createTestContext, type TestContext } from '../testUtil/testApp.js';

describe('models routes', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('upload -> catalog row -> fetch info -> delete lifecycle', async () => {
    ctx = await createTestContext();

    const uploadRes = await request(ctx.app).post('/api/models').attach('file', fbxBuffer(), 'pump-assembly.fbx');
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.status).toBe('queued');
    expect(uploadRes.body.name).toBe('pump-assembly');
    const modelId = uploadRes.body.id as string;

    const listRes = await request(ctx.app).get('/api/models');
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((m: { id: string }) => m.id === modelId)).toBe(true);

    const getRes = await request(ctx.app).get(`/api/models/${modelId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(modelId);

    const deleteRes = await request(ctx.app).delete(`/api/models/${modelId}`);
    expect(deleteRes.status).toBe(204);

    const getAfterDelete = await request(ctx.app).get(`/api/models/${modelId}`);
    expect(getAfterDelete.status).toBe(404);
    expect(getAfterDelete.headers['content-type']).toContain('application/problem+json');
  });

  it('an uploaded GLB self-publishes immediately (no worker needed) and streams via /files', async () => {
    ctx = await createTestContext();
    const glb = glbBuffer();

    const uploadRes = await request(ctx.app).post('/api/models').attach('file', glb, 'model.glb');
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.status).toBe('ready');
    expect(uploadRes.body.currentRevision).toBe(1);
    expect(uploadRes.body.artifactUrl).toBeTruthy();

    const fileRes = await request(ctx.app).get(uploadRes.body.artifactUrl as string);
    expect(fileRes.status).toBe(200);
    expect(Buffer.compare(fileRes.body as Buffer, glb)).toBe(0);
  });

  it('Range request returns 206 with the exact requested byte window', async () => {
    ctx = await createTestContext();
    const glb = glbBuffer();
    const uploadRes = await request(ctx.app).post('/api/models').attach('file', glb, 'model.glb');
    const url = uploadRes.body.artifactUrl as string;

    const rangeRes = await request(ctx.app).get(url).set('Range', 'bytes=2-5');
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers['content-range']).toBe(`bytes 2-5/${glb.length}`);
    expect(rangeRes.headers['content-length']).toBe('4');
    expect(Buffer.compare(rangeRes.body as Buffer, glb.subarray(2, 6))).toBe(0);
  });

  it('batch upload of a file GROUP (fbx+mdb2+llh, same basename) -> exactly ONE queued row', async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app)
      .post('/api/models/batch')
      .attach('files', fbxBuffer(), 'tank-42.fbx')
      .attach('files', accessBuffer(), 'tank-42.mdb2')
      .attach('files', llhTextBuffer(), 'tank-42.llh');

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sourceFiles).toHaveLength(3);
    expect(res.body[0].status).toBe('queued'); // not directly renderable — awaits Phase 4's worker

    const listRes = await request(ctx.app).get('/api/models');
    expect(listRes.body).toHaveLength(1);
  });

  it('two distinct basenames in one batch request create two separate rows', async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app)
      .post('/api/models/batch')
      .attach('files', fbxBuffer(), 'tank-42.fbx')
      .attach('files', fbxBuffer(), 'pump-7.fbx');

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
  });

  it('GET /api/models/{id}/linkage-map returns 404 before any revision is published', async () => {
    ctx = await createTestContext();
    const uploadRes = await request(ctx.app).post('/api/models').attach('file', fbxBuffer(), 'pump-assembly.fbx');
    const modelId = uploadRes.body.id as string;

    const res = await request(ctx.app).get(`/api/models/${modelId}/linkage-map`);
    expect(res.status).toBe(404);
  });

  it('GET /api/models/{id}/linkage-map serves the sidecar the Phase 4 worker writes alongside a published revision', async () => {
    ctx = await createTestContext();
    const glbRes = await request(ctx.app).post('/api/models').attach('file', glbBuffer(), 'model.glb');
    const modelId = glbRes.body.id as string;
    expect(glbRes.body.currentRevision).toBe(1);

    const sidecarDir = path.join(ctx.config.modelsArtifactsDir, modelId, '1');
    await fsp.mkdir(sidecarDir, { recursive: true });
    await fsp.writeFile(path.join(sidecarDir, 'linkage-map.json'), JSON.stringify({ 'Pump-1': 'LINK-1001' }));

    const res = await request(ctx.app).get(`/api/models/${modelId}/linkage-map`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'Pump-1': 'LINK-1001' });
  });

  it('rejects a .fbx-named text file (magic-byte mismatch)', async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app).post('/api/models').attach('file', fakeFbxTextBuffer(), 'fake.fbx');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');

    const listRes = await request(ctx.app).get('/api/models');
    expect(listRes.body).toHaveLength(0); // rejected upload must not create a row
  });
});
