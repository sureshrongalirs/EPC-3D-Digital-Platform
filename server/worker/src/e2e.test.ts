import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Document, NodeIO } from '@gltf-transform/core';
import type { ModelRow } from '@plantscope/server-shared';
import { toModelDtoWithArtifact } from '@plantscope/server-shared';
import { describe, expect, it } from 'vitest';

import { isAssimpAvailable } from './adapters/fbx/assimp.js';
import type { Config } from './config.js';
import { processJob } from './pipeline.js';
import { createTestDb, type TestDbContext } from './testUtil/db.js';

const execFileAsync = promisify(execFile);

// This test needs a real, assimp-parseable FBX binary, not the hand-built
// testdata/fixtures/linkage-fixture.fbx (that fixture is deliberately minimal -- just enough
// structure to exercise parseFBXLinkages()'s Properties70 walk -- and lacks the
// GlobalSettings/Definitions/Connections sections a real FBX needs before assimp will treat
// it as a valid scene). Rather than hand-author a second, fuller fixture, this generates a
// trivial GLB and has assimp itself author the FBX by round-tripping GLB -> FBX -> GLB, which
// guarantees a file assimp considers valid. The tradeoff: an assimp-authored FBX has no
// custom "Linkages" Properties70 entries (that's this repo's own convention, not something
// assimp knows to write), so this test cannot also exercise linkage-key recovery -- that is
// covered separately and thoroughly by adapters/fbx/linkage.test.ts against the hand-built
// fixture. What this test actually proves is the full pipeline wiring: real assimp
// export, triangle-count parity, Draco compression, publish, and the linkage-map endpoint's
// empty-but-correct response when a source genuinely has no recovered keys.
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

describe.skipIf(!assimpAvailable)('E2E: FBX -> GLB -> linkage map -> catalog (skipped if assimp is not installed)', () => {
  it('converts a real FBX end to end and the model/linkage-map data server/api would serve is correct', async () => {
    const ctx: TestDbContext = await createTestDb();
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-worker-e2e-'));

    try {
      const fbxPath = await buildAssimpAuthoredFbx(dataDir);

      const config: Config = {
        dataDir,
        modelsRawDir: path.join(dataDir, 'models', 'raw'),
        modelsArtifactsDir: path.join(dataDir, 'models', 'artifacts'),
        databaseUrl: '',
        parallelism: 2,
        stallTimeoutMs: 60_000,
        largeJobMb: 250,
        sizeThresholdMb: 100,
        pollIntervalMs: 1000,
        dracoForCesium: false,
        splitterTriangleFloor: 50,
      };

      const modelId = 'e2e-model';
      const rawDir = path.join(config.modelsRawDir, modelId);
      await fsp.mkdir(rawDir, { recursive: true });
      const rawFbxPath = path.join(rawDir, 'triangle.fbx');
      await fsp.copyFile(fbxPath, rawFbxPath);

      const sourceFiles = [{ kind: 'fbx', path: `models/raw/${modelId}/triangle.fbx`, originalName: 'triangle.fbx' }];
      await ctx.db.knex('models').insert({
        id: modelId,
        name: 'E2E triangle',
        source_format: 'fbx',
        size_bytes: 1,
        status: 'queued',
        current_revision: null,
        site_id: null,
        error: null,
        source_files: JSON.stringify(sourceFiles),
      });

      const model = (await ctx.db.knex<ModelRow>('models').where({ id: modelId }).first())!;
      await processJob(ctx.db, config, silentLogger(), model);

      // Equivalent to "GET /api/models shows ready": same repo function server/api's route
      // calls, against the same row this job just updated.
      const updatedRow = (await ctx.db.knex<ModelRow>('models').where({ id: modelId }).first())!;
      const dto = await toModelDtoWithArtifact(ctx.db, updatedRow);
      expect(dto.status).toBe('ready');
      expect(dto.currentRevision).toBe(1);
      expect(dto.artifactUrl).toBe('/files/models/artifacts/e2e-model/1/model.glb');

      const glbStat = await fsp.stat(path.join(config.modelsArtifactsDir, modelId, '1', 'model.glb'));
      expect(glbStat.size).toBeGreaterThan(0);

      // Equivalent to "GET /api/models/{id}/linkage-map returns the recovered keys": an
      // assimp-authored FBX has none (see this file's header comment), so the correct,
      // fully-wired result here is an empty map plus the adapter's own warning about it.
      const sidecarPath = path.join(config.modelsArtifactsDir, modelId, '1', 'linkage-map.json');
      await expect(fsp.access(sidecarPath)).rejects.toThrow();
      expect(dto.warnings).toContain('no Linkages properties recovered from this FBX (Properties70 scan found none)');
    } finally {
      await ctx.cleanup();
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
