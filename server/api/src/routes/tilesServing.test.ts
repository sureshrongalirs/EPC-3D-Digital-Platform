import fsp from 'node:fs/promises';
import path from 'node:path';

import { publishRevision } from '@plantscope/server-shared';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { fbxBuffer, glbBuffer } from '../testUtil/fixtures.js';
import { createTestContext, type TestContext } from '../testUtil/testApp.js';

/**
 * Task 3 deliverables 1 (catalog contract, revision-addressed serving, cache/ETag headers,
 * republish-new-URLs) and 2 (relative-URI correctness). Synthetic fixtures only (CLAUDE.md
 * invariant #8) -- these never invoke server/worker or a real mago-3d-tiler run; a tiles
 * revision is published directly via the shared publishRevision(), same as pipeline.test.ts's
 * own pattern, so these tests exercise server/api's serving layer in isolation.
 */

interface TileNode {
  content?: { uri: string };
  children?: TileNode[];
}

/** Writes a small, real-shaped (but synthetic) tileset directory: tileset.json referencing
 * two tile content files via RELATIVE URIs, plus metadata.json -- the exact directory layout
 * tileGlb()/splitObjects() produce for a real tiles publish (see server/worker/src/adapters/
 * tiles/index.ts's own tilesetPath/metadataPath conventions). */
async function writeSyntheticTilesRevision(
  artifactsDir: string,
  modelId: string,
  revision: number,
  seed: string,
): Promise<{ artifactPath: string }> {
  const outDir = path.join(artifactsDir, modelId, String(revision));
  const tilesDir = path.join(outDir, 'tiles');
  const dataDir = path.join(tilesDir, 'data');
  await fsp.mkdir(dataDir, { recursive: true });

  const tileset = {
    asset: { version: '1.1' },
    geometricError: 100,
    root: {
      boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
      geometricError: 100,
      content: { uri: 'data/root.glb' },
      children: [
        {
          boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
          geometricError: 10,
          content: { uri: 'data/child.glb' },
        },
      ],
    },
  };
  await fsp.writeFile(path.join(tilesDir, 'tileset.json'), JSON.stringify(tileset));
  await fsp.writeFile(path.join(dataDir, 'root.glb'), Buffer.from(`root-${seed}`));
  await fsp.writeFile(path.join(dataDir, 'child.glb'), Buffer.from(`child-${seed}-0123456789`));

  const metadata = {
    version: 1,
    objects: [
      { file: 'root.glb', path: ['root'], name: 'root', kind: 'normal', linkageKey: '1 2 3 4', triangleCount: 12 },
      { file: 'child.glb', path: ['child'], name: 'child', kind: 'normal', triangleCount: 6 },
    ],
  };
  await fsp.writeFile(path.join(outDir, 'metadata.json'), JSON.stringify(metadata));

  const artifactPath = ['models', 'artifacts', modelId, String(revision), 'tiles', 'tileset.json'].join('/');
  return { artifactPath };
}

/** Collects every content URI a tileset references, recursively, resolved relative to the
 * tileset.json's own directory (per the OGC 3D Tiles spec's relative-URI convention). */
function collectContentUris(node: TileNode, baseDir: string, out: string[]): void {
  if (node.content?.uri) out.push(`${baseDir}/${node.content.uri}`);
  for (const child of node.children ?? []) collectContentUris(child, baseDir, out);
}

async function createFbxModelId(app: TestContext['app']): Promise<string> {
  const res = await request(app).post('/api/models').attach('file', fbxBuffer(), 'plant.fbx');
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('tiles serving (Task 3 deliverables 1 + 2)', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('catalog contract: a tiles revision exposes renderPath/tilesetUrl/metadataUrl/tilesSummary; a glb revision leaves them null', async () => {
    ctx = await createTestContext();
    const modelId = await createFbxModelId(ctx.app);

    const { artifactPath } = await writeSyntheticTilesRevision(ctx.config.modelsArtifactsDir, modelId, 1, 'v1');
    await publishRevision(ctx.db, {
      modelId,
      revision: 1,
      artifactType: 'tiles',
      artifactPath,
      tilesSummary: { inputSizeBytes: 12345, objectCount: 2, tileCount: 2, maxTileBytes: 20, durationMs: 42, repairFired: false },
    });

    const res = await request(ctx.app).get(`/api/models/${modelId}`);
    expect(res.status).toBe(200);
    expect(res.body.renderPath).toBe('tiles');
    expect(res.body.artifactType).toBe('tiles');
    expect(res.body.tilesetUrl).toBe(res.body.artifactUrl);
    expect(res.body.tilesetUrl).toBe(`/files/${artifactPath}`);
    expect(res.body.metadataUrl).toBe(`/files/models/artifacts/${modelId}/1/metadata.json`);
    expect(res.body.tilesSummary).toEqual({
      inputSizeBytes: 12345,
      objectCount: 2,
      tileCount: 2,
      maxTileBytes: 20,
      durationMs: 42,
      repairFired: false,
    });
  });

  it('a glb-backed model has null renderPath-derived fields (not just null artifactType)', async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app).post('/api/models').attach('file', glbBuffer(), 'model.glb');
    expect(res.body.renderPath).toBe('glb');
    expect(res.body.tilesetUrl).toBeNull();
    expect(res.body.metadataUrl).toBeNull();
    expect(res.body.tilesSummary).toBeNull();
  });

  it('GET /api/models/{id}/metadata serves metadata.json for a published tiles revision, 404s before publish', async () => {
    ctx = await createTestContext();
    const modelId = await createFbxModelId(ctx.app);

    const before = await request(ctx.app).get(`/api/models/${modelId}/metadata`);
    expect(before.status).toBe(404);

    const { artifactPath } = await writeSyntheticTilesRevision(ctx.config.modelsArtifactsDir, modelId, 1, 'v1');
    await publishRevision(ctx.db, { modelId, revision: 1, artifactType: 'tiles', artifactPath });

    const after = await request(ctx.app).get(`/api/models/${modelId}/metadata`);
    expect(after.status).toBe(200);
    expect(after.body.objects).toHaveLength(2);
    expect(after.body.objects[0].file).toBe('root.glb');
  });

  it('relative-URI correctness: every content URI tileset.json references resolves to a 200 via the live API (targets bug #11\'s failure class)', async () => {
    ctx = await createTestContext();
    const modelId = await createFbxModelId(ctx.app);
    const { artifactPath } = await writeSyntheticTilesRevision(ctx.config.modelsArtifactsDir, modelId, 1, 'v1');
    await publishRevision(ctx.db, { modelId, revision: 1, artifactType: 'tiles', artifactPath });

    const modelRes = await request(ctx.app).get(`/api/models/${modelId}`);
    const tilesetUrl = modelRes.body.tilesetUrl as string;

    const tilesetRes = await request(ctx.app).get(tilesetUrl);
    expect(tilesetRes.status).toBe(200);
    // /files/* serves tileset.json with Content-Type: application/octet-stream (a generic
    // static file, not application/json), so supertest buffers the response as .body (a
    // Buffer), not a parsed object or .text -- this is itself a real observation: a
    // tiles-aware client fetching tileset.json via this route gets octet-stream, not json,
    // the same as any other file, and must parse it itself (3d-tiles-renderer's own
    // TilesRenderer does exactly this).
    const tileset = JSON.parse((tilesetRes.body as Buffer).toString('utf8')) as { root: TileNode };

    const baseDir = tilesetUrl.slice(0, tilesetUrl.lastIndexOf('/'));
    const contentUris: string[] = [];
    collectContentUris(tileset.root, baseDir, contentUris);
    expect(contentUris).toHaveLength(2);

    for (const uri of contentUris) {
      const contentRes = await request(ctx.app).get(uri);
      expect(contentRes.status, `expected 200 for ${uri}`).toBe(200);
    }
  });

  it('tile content is served with Range support, immutable cache-control, and an ETag', async () => {
    ctx = await createTestContext();
    const modelId = await createFbxModelId(ctx.app);
    const { artifactPath } = await writeSyntheticTilesRevision(ctx.config.modelsArtifactsDir, modelId, 1, 'v1');
    await publishRevision(ctx.db, { modelId, revision: 1, artifactType: 'tiles', artifactPath });

    const tileUrl = `/files/models/artifacts/${modelId}/1/tiles/data/child.glb`;
    const fullRes = await request(ctx.app).get(tileUrl);
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(fullRes.headers['etag']).toBeTruthy();

    const rangeRes = await request(ctx.app).get(tileUrl).set('Range', 'bytes=0-4');
    expect(rangeRes.status).toBe(206);
    expect(Buffer.compare(rangeRes.body as Buffer, Buffer.from('child'))).toBe(0);
  });

  it('republish (tiles DIRECTORY case): revision 2 gets entirely new URLs for tileset.json AND every tile file; revision 1\'s old URLs still serve the old bytes', async () => {
    ctx = await createTestContext();
    const modelId = await createFbxModelId(ctx.app);

    const rev1 = await writeSyntheticTilesRevision(ctx.config.modelsArtifactsDir, modelId, 1, 'v1');
    await publishRevision(ctx.db, { modelId, revision: 1, artifactType: 'tiles', artifactPath: rev1.artifactPath });
    const rev1Model = await request(ctx.app).get(`/api/models/${modelId}`);
    const rev1TilesetUrl = rev1Model.body.tilesetUrl as string;
    const rev1ChildUrl = `/files/models/artifacts/${modelId}/1/tiles/data/child.glb`;

    const rev2 = await writeSyntheticTilesRevision(ctx.config.modelsArtifactsDir, modelId, 2, 'v2');
    await publishRevision(ctx.db, { modelId, revision: 2, artifactType: 'tiles', artifactPath: rev2.artifactPath });
    const rev2Model = await request(ctx.app).get(`/api/models/${modelId}`);
    const rev2TilesetUrl = rev2Model.body.tilesetUrl as string;
    const rev2ChildUrl = `/files/models/artifacts/${modelId}/2/tiles/data/child.glb`;

    // Directory-level URLs differ, not just the single tileset.json file.
    expect(rev2TilesetUrl).not.toBe(rev1TilesetUrl);
    expect(rev2ChildUrl).not.toBe(rev1ChildUrl);

    // Revision 1's own old URLs are untouched -- still resolve, still serve v1's bytes.
    const oldChildRes = await request(ctx.app).get(rev1ChildUrl);
    expect(oldChildRes.status).toBe(200);
    expect(Buffer.compare(oldChildRes.body as Buffer, Buffer.from('child-v1-0123456789'))).toBe(0);

    // Revision 2's new URLs serve v2's bytes.
    const newChildRes = await request(ctx.app).get(rev2ChildUrl);
    expect(newChildRes.status).toBe(200);
    expect(Buffer.compare(newChildRes.body as Buffer, Buffer.from('child-v2-0123456789'))).toBe(0);

    // The catalog now points at revision 2.
    expect(rev2Model.body.currentRevision).toBe(2);
  });
});
