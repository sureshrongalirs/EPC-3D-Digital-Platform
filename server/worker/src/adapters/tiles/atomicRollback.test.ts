import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Document, NodeIO } from '@gltf-transform/core';
import type { ModelRow } from '@plantscope/server-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./magoTiler.js', () => ({
  runMagoTiler: vi.fn(),
}));

import { isAssimpAvailable } from '../fbx/assimp.js';
import type { Config } from '../../config.js';
import { processJob } from '../../pipeline.js';
import { createTestDb, type TestDbContext } from '../../testUtil/db.js';
import { runMagoTiler } from './magoTiler.js';

const execFileAsync = promisify(execFile);
const mockedRunMagoTiler = vi.mocked(runMagoTiler);

// Same technique as index.test.ts's buildAssimpAuthoredFbx: assimp itself authors a real FBX
// by round-tripping a trivial GLB -> FBX, so this exercises the real fbxAdapter.convert() ->
// tileGlb() path (not a stand-in), just with mago-3d-tiler's own output mocked out (no real
// java/mago binary needed to prove the *atomicity* guarantee -- that's orthogonal to whether
// mago itself is installed).
async function buildAssimpAuthoredFbx(dir: string): Promise<string> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const positionAccessor = doc.createAccessor('positions').setType('VEC3').setArray(positions).setBuffer(buffer);
  const indexAccessor = doc.createAccessor('indices').setType('SCALAR').setArray(indices).setBuffer(buffer);
  const primitive = doc.createPrimitive().setAttribute('POSITION', positionAccessor).setIndices(indexAccessor);
  const mesh = doc.createMesh('Triangle').addPrimitive(primitive);
  const node = doc.createNode('Triangle').setMesh(mesh);
  doc.createScene('Scene').addChild(node);

  const glbPath = path.join(dir, 'triangle.glb');
  await new NodeIO().write(glbPath, doc);

  const fbxPath = path.join(dir, 'triangle.fbx');
  await execFileAsync('assimp', ['export', glbPath, fbxPath]);
  return fbxPath;
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger() } as unknown as import('pino').Logger;
}

const assimpAvailable = await isAssimpAvailable();

describe.skipIf(!assimpAvailable)('tiles integrity gate: atomic rollback on unrepairable output (skipped if assimp is not installed)', () => {
  afterEach(() => {
    mockedRunMagoTiler.mockReset();
  });

  it('a job whose tiling output mago-3d-tiler crashed on (non-zero exit, no usable tileset) never publishes: current_revision stays null and no revisions row is written', async () => {
    const ctx: TestDbContext = await createTestDb();
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-worker-tiles-rollback-'));

    try {
      mockedRunMagoTiler.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'TileProcessingException: Tileset root node children is null or empty',
      });

      const fbxPath = await buildAssimpAuthoredFbx(dataDir);

      const config: Config = {
        dataDir,
        modelsRawDir: path.join(dataDir, 'models', 'raw'),
        modelsArtifactsDir: path.join(dataDir, 'models', 'artifacts'),
        databaseUrl: '',
        parallelism: 2,
        stallTimeoutMs: 60_000,
        largeJobMb: 250,
        sizeThresholdMb: 0,
        pollIntervalMs: 1000,
        dracoForCesium: false,
        splitterTriangleFloor: 50,
      };

      const modelId = 'tiles-rollback-test-model';
      const rawDir = path.join(config.modelsRawDir, modelId);
      await fsp.mkdir(rawDir, { recursive: true });
      const rawFbxPath = path.join(rawDir, 'triangle.fbx');
      await fsp.copyFile(fbxPath, rawFbxPath);

      const sourceFiles = [{ kind: 'fbx', path: `models/raw/${modelId}/triangle.fbx`, originalName: 'triangle.fbx' }];
      await ctx.db.knex('models').insert({
        id: modelId,
        name: 'triangle',
        source_format: 'fbx',
        size_bytes: (await fsp.stat(rawFbxPath)).size,
        status: 'queued',
        current_revision: null,
        site_id: null,
        error: null,
        source_files: JSON.stringify(sourceFiles),
      });

      const model = (await ctx.db.knex<ModelRow>('models').where({ id: modelId }).first())!;

      await expect(processJob(ctx.db, config, silentLogger(), model)).rejects.toThrow(/mago-3d-tiler produced no usable tileset/);

      // processJob itself only throws (the runner is what flips status to 'failed', per
      // pipeline.test.ts's equivalent test for a format-resolution failure) -- but regardless
      // of who catches it, publishRevision() must never have run: current_revision stays
      // null and no revisions row exists, so nothing a reader can see ever points at the
      // broken output (CLAUDE.md invariant #6).
      const updated = await ctx.db.knex('models').where({ id: modelId }).first<{ current_revision: number | null; status: string }>();
      expect(updated?.current_revision).toBeNull();
      expect(updated?.status).toBe('queued');

      const revisions = await ctx.db.knex('revisions').where({ model_id: modelId });
      expect(revisions).toHaveLength(0);
    } finally {
      await ctx.cleanup();
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });
});
