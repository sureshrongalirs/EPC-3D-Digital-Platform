import crypto from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from '../testUtil/testApp.js';
import { resolveRotation } from './rotationPrecedence.js';

describe('resolveRotation', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('no site, no override -> default/0', async () => {
    ctx = await createTestContext();
    expect(await resolveRotation(ctx.db, null, null)).toEqual({ rotationDeg: 0, rotationSource: 'default' });
  });

  it('site with rotation_deg set, no override -> inherits, site_inherited', async () => {
    ctx = await createTestContext();
    const siteId = crypto.randomUUID();
    await ctx.db.knex('sites').insert({ id: siteId, name: 'Site A', rotation_deg: 42 });

    expect(await resolveRotation(ctx.db, siteId, null)).toEqual({
      rotationDeg: 42,
      rotationSource: 'site_inherited',
    });
  });

  it('an explicit rotation wins regardless of site -> model_override', async () => {
    ctx = await createTestContext();
    const siteId = crypto.randomUUID();
    await ctx.db.knex('sites').insert({ id: siteId, name: 'Site B', rotation_deg: 42 });

    expect(await resolveRotation(ctx.db, siteId, 99)).toEqual({
      rotationDeg: 99,
      rotationSource: 'model_override',
    });
  });

  it('site exists but has no rotation set -> default/0', async () => {
    ctx = await createTestContext();
    const siteId = crypto.randomUUID();
    await ctx.db.knex('sites').insert({ id: siteId, name: 'Site C', rotation_deg: null });

    expect(await resolveRotation(ctx.db, siteId, null)).toEqual({ rotationDeg: 0, rotationSource: 'default' });
  });
});
