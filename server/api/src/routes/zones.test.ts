import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { fbxBuffer } from '../testUtil/fixtures.js';
import { createTestContext, type TestContext } from '../testUtil/testApp.js';

describe('zones routes', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('create -> list -> members -> delete', async () => {
    ctx = await createTestContext();
    const modelRes = await request(ctx.app).post('/api/models').attach('file', fbxBuffer(), 'model.fbx');
    const modelId = modelRes.body.id as string;

    const createRes = await request(ctx.app).post('/api/zones').send({
      modelId,
      name: 'Pumps',
      color: '#2a7fff',
      members: ['Pump-1', 'Pump-2'],
      footprint: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      zmin: 0,
      zmax: 2,
    });
    expect(createRes.status).toBe(201);
    const zoneId = createRes.body.id as string;

    const listRes = await request(ctx.app).get(`/api/zones?model=${modelId}`);
    expect(listRes.body).toHaveLength(1);

    const membersRes = await request(ctx.app).get(`/api/zones/${zoneId}/members`);
    expect(membersRes.body).toHaveLength(2);
    expect(membersRes.body.map((m: { linkageKey: string }) => m.linkageKey).sort()).toEqual(['Pump-1', 'Pump-2']);

    const deleteRes = await request(ctx.app).delete(`/api/zones/${zoneId}`);
    expect(deleteRes.status).toBe(204);

    const membersAfterDelete = await request(ctx.app).get(`/api/zones/${zoneId}/members`);
    expect(membersAfterDelete.status).toBe(404);
  });

  it('re-posting the same zone id upserts (replacing members) rather than duplicating', async () => {
    ctx = await createTestContext();
    const modelRes = await request(ctx.app).post('/api/models').attach('file', fbxBuffer(), 'model.fbx');
    const modelId = modelRes.body.id as string;

    const zonePayload = {
      id: 'zone-fixed-id',
      modelId,
      name: 'Pumps',
      color: '#2a7fff',
      members: ['Pump-1'],
      footprint: [{ x: 0, y: 0 }],
      zmin: 0,
      zmax: 1,
    };
    await request(ctx.app).post('/api/zones').send(zonePayload);
    const updateRes = await request(ctx.app)
      .post('/api/zones')
      .send({ ...zonePayload, name: 'Pumps Renamed', members: ['Pump-1', 'Pump-2'] });

    expect(updateRes.body.name).toBe('Pumps Renamed');

    const listRes = await request(ctx.app).get(`/api/zones?model=${modelId}`);
    expect(listRes.body).toHaveLength(1);

    const membersRes = await request(ctx.app).get(`/api/zones/zone-fixed-id/members`);
    expect(membersRes.body).toHaveLength(2);
  });
});
