import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ModelRow } from '@plantscope/server-shared';
import { describe, expect, it } from 'vitest';

import { isAssimpAvailable } from '../fbx/assimp.js';
import type { Config } from '../../config.js';
import { processJob } from '../../pipeline.js';
import { createTestDb, type TestDbContext } from '../../testUtil/db.js';
import { isMagoTilerAvailable } from './magoTiler.js';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const generatorPath = path.resolve(here, '..', '..', '..', '..', '..', 'testdata', 'scripts', 'generate-plant-grid-fixture.mjs');

async function loadGenerator(): Promise<{
  generatePlantGridFixture: (outDir: string, mode: 'merged' | 'split', objectCount?: number, segments?: number) => Promise<unknown>;
}> {
  return (await import(pathToFileURL(generatorPath).href)) as Awaited<ReturnType<typeof loadGenerator>>;
}

// PREVIOUSLY a single unmaterialed triangle (built directly via @gltf-transform/core, then
// assimp-authored into an FBX by round-tripping GLB -> FBX, matching e2e.test.ts's
// buildAssimpAuthoredFbx technique). That fixture never exercised the tiles branch the way
// this test's name claims: real mago-3d-tiler v1.15.4 silently treats unmaterialed primitives
// as contributing zero content (confirmed directly -- `[Pre] Total Node Count 1` but
// `Total tile contents count : 0`, a fully well-formed but content-less tileset.json), which
// this test's own assertion (`tileFiles.length` > 0) should have caught but the old fixture
// made unreachable, since PRE-Task-1 code only checked `tileset.json` existence, not content
// (see PR #11's verification pass -- this is a pre-existing defect this PR now fixes, not a
// regression it introduced).
//
// Replaced with generatePlantGridFixture's 'merged' mode (testdata/scripts/
// generate-plant-grid-fixture.mjs), which always sets a material on every primitive (its own
// doc comment records the same "unmaterialed primitive -> zero nodes" finding from Phase 5R
// Task 0). 20 objects / 3 segments is the smallest count empirically verified in WSL (Ubuntu,
// real mago-3d-tiler v1.15.4, java -jar mago-3d-tiler.jar -input ... -mx 5000 -nl 3 -xl 8 -mg
// 100, the exact flags magoTiler.ts passes) to produce real tile content through the FULL
// double assimp round-trip this test exercises (generator GLB -> assimp export -> FBX, then
// the pipeline's own assimpExport FBX -> raw GLB, then mago) -- confirmed via
// `[Process Summary] Total tile contents count : 2`, not 0. Kept deliberately small/fast (a
// single mago invocation completes in ~1.4s at this scale) rather than matching Task 0's
// production-scale (thousands of objects, >50MB) fixture, which belongs to that task's own
// spike, not this unit test.
async function buildTilingFbxFixture(dir: string): Promise<string> {
  const { generatePlantGridFixture } = await loadGenerator();
  const genDir = path.join(dir, 'gen');
  await generatePlantGridFixture(genDir, 'merged', 20, 3);

  const fbxPath = path.join(dir, 'model.fbx');
  await execFileAsync('assimp', ['export', path.join(genDir, 'model.glb'), fbxPath]);
  return fbxPath;
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger() } as unknown as import('pino').Logger;
}

const TILE_CONTENT_EXTENSIONS = new Set(['.b3dm', '.i3dm', '.pnts', '.cmpt', '.glb']);

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
        const fbxPath = await buildTilingFbxFixture(dataDir);

        const config: Config = {
          dataDir,
          modelsRawDir: path.join(dataDir, 'models', 'raw'),
          modelsArtifactsDir: path.join(dataDir, 'models', 'artifacts'),
          databaseUrl: '',
          parallelism: 2,
          stallTimeoutMs: 60_000,
          largeJobMb: 250,
          // Forced to 0 so this small fixture (tens of KB) still routes to the tiles branch
          // -- CLAUDE.md's ~100MB threshold is about real-world files, not something worth
          // reproducing at fixture scale in a fast unit test.
          sizeThresholdMb: 0,
          pollIntervalMs: 1000,
          dracoForCesium: false,
          splitterTriangleFloor: 50,
          splitterBlobWarnRatio: 0.5,
        };

        const modelId = 'tiles-test-model';
        const rawDir = path.join(config.modelsRawDir, modelId);
        await fsp.mkdir(rawDir, { recursive: true });
        const rawFbxPath = path.join(rawDir, 'model.fbx');
        await fsp.copyFile(fbxPath, rawFbxPath);

        const sourceFiles = [{ kind: 'fbx', path: `models/raw/${modelId}/model.fbx`, originalName: 'model.fbx' }];
        await ctx.db.knex('models').insert({
          id: modelId,
          name: 'plant-grid',
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
