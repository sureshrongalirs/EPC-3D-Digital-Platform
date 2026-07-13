import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Document, NodeIO } from '@gltf-transform/core';
import type { ModelRow } from '@plantscope/server-shared';
import { describe, expect, it } from 'vitest';

import { isAssimpAvailable } from '../fbx/assimp.js';
import type { Config } from '../../config.js';
import { processJob } from '../../pipeline.js';
import { createTestDb, type TestDbContext } from '../../testUtil/db.js';
import { isMagoTilerAvailable } from './magoTiler.js';

const execFileAsync = promisify(execFile);

// Same technique as e2e.test.ts's buildAssimpAuthoredFbx: a hand-built FBX won't pass
// assimp's own validity checks, so this has assimp itself author a real FBX by round-tripping
// a trivial GLB -> FBX. That means this fixture carries no custom "Linkages" Properties70
// entries (assimp doesn't know this repo's convention) -- linkage-key recovery itself is
// covered separately by adapters/fbx/linkage.test.ts's hand-built fixture. What this test
// actually proves is the tiles branch of the real pipeline: routing, mago-3d-tiler
// invocation, the 8MB-per-tile budget, and the linkage-map sidecar still being written
// (empty, since this fixture has no Linkages -- see below) alongside tileset.json.
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

const TILE_CONTENT_EXTENSIONS = new Set(['.b3dm', '.i3dm', '.pnts', '.cmpt']);

async function listTileFilesRecursively(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTileFilesRecursively(full)));
    } else if (TILE_CONTENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

const assimpAvailable = await isAssimpAvailable();
const magoTilerAvailable = await isMagoTilerAvailable();

describe.skipIf(!assimpAvailable || !magoTilerAvailable)(
  'tiling pipeline (skipped if assimp or mago-3d-tiler is not installed)',
  () => {
    it('routes a source over sizeThresholdMb to tiles, producing tileset.json + tiles under 8MB + a linkage-map.json sidecar', async () => {
      const ctx: TestDbContext = await createTestDb();
      const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-worker-tiles-'));

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
          // Forced to 0 so this trivial fixture (a few hundred bytes) still routes to the
          // tiles branch -- CLAUDE.md's ~100MB threshold is about real-world files, not
          // something worth reproducing at fixture scale in a fast unit test.
          sizeThresholdMb: 0,
          pollIntervalMs: 1000,
          dracoForCesium: false,
        };

        const modelId = 'tiles-test-model';
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
        await processJob(ctx.db, config, silentLogger(), model);

        const outDir = path.join(config.modelsArtifactsDir, modelId, '1');
        const tilesetPath = path.join(outDir, 'tiles', 'tileset.json');
        const tilesetStat = await fsp.stat(tilesetPath);
        expect(tilesetStat.isFile()).toBe(true);

        const tileFiles = await listTileFilesRecursively(path.join(outDir, 'tiles'));
        expect(tileFiles.length).toBeGreaterThan(0);
        for (const file of tileFiles) {
          const stat = await fsp.stat(file);
          expect(stat.size).toBeLessThanOrEqual(8 * 1024 * 1024);
        }

        // This fixture is assimp-authored (no custom Linkages Properties70 entries -- see
        // this file's top comment), so the sidecar is only written when linkageMap is
        // non-empty (pipeline.ts's behavior); assert the *routing and tiling* worked instead
        // of asserting sidecar presence for a fixture that structurally can't produce one.
        const row = await ctx.db.knex('models').where({ id: modelId }).first<{ status: string }>();
        expect(row?.status).toBe('ready');
      } finally {
        await ctx.cleanup();
        await fsp.rm(dataDir, { recursive: true, force: true });
      }
    });
  },
);
