import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./magoTiler.js', () => ({
  runMagoTiler: vi.fn(),
}));

// Partial mock: every real export (loadTileset/validateTileset/writeTileset) stays real --
// the gate's actual logic is what's under test -- except repairTileset, wrapped in a vi.fn()
// that still calls through to the real implementation, so tests can assert "was this called
// at all" (spy) without changing behavior on paths where it legitimately runs.
vi.mock('./tilesetIntegrity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tilesetIntegrity.js')>();
  return { ...actual, repairTileset: vi.fn(actual.repairTileset) };
});

import { tileGlb } from './index.js';
import { runMagoTiler } from './magoTiler.js';
import { repairTileset } from './tilesetIntegrity.js';

const mockedRunMagoTiler = vi.mocked(runMagoTiler);
const mockedRepairTileset = vi.mocked(repairTileset);

// Verbatim tileset.json written by real mago-3d-tiler v1.15.4 (see tilesetIntegrity.test.ts's
// identical constant for provenance) -- a fully well-formed root+children+geometricError
// chain with zero `content`/`contents` keys anywhere.
const REAL_MAGO_ZERO_CONTENT_TILESET =
  '{"asset":{"version":"1.1"},"geometricError":16.0,"root":{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":16.0,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":256.1,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":128.1,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":64.1,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":32.1,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":16.1,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":8.1}]}]}]}]}]}]},"extensionsUsed":["3DTILES_content_gltf"],"extensions":{"3DTILES_content_gltf":{}}}';

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-tileglb-integrity-'));
}

async function makeRawGlb(dir: string): Promise<string> {
  const rawGlbPath = path.join(dir, 'model.glb');
  // tileGlb only ever renames this file into a staging dir; its content is never parsed, so
  // any bytes are fine.
  await fsp.writeFile(rawGlbPath, Buffer.from([0]));
  return rawGlbPath;
}

/** A minimal, real, parseable GLB -- repairTileset() (case (b)) reads actual GLB geometry to
 * compute a bounding volume, so its test fixture can't be arbitrary bytes the way the case
 * (c) fixtures below can (those paths never reach repair/GLB-parsing code at all). */
async function writeTestGlb(glbPath: string): Promise<void> {
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
  await new NodeIO().write(glbPath, doc);
}

async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected tileGlb() to reject, but it resolved');
}

describe('tileGlb integrity gate wiring (case (c): hard job failure, exit code + last log lines)', () => {
  afterEach(() => {
    mockedRunMagoTiler.mockReset();
    mockedRepairTileset.mockClear();
  });

  it('a non-zero exit short-circuits straight to failure -- even when the output dir happens to contain a fully valid, repair-free tileset', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir) => {
        await fsp.mkdir(outputDir, { recursive: true });
        await fsp.writeFile(path.join(outputDir, 'content.glb'), Buffer.from([1, 2, 3]));
        await fsp.writeFile(
          path.join(outputDir, 'tileset.json'),
          JSON.stringify({ root: { content: { uri: 'content.glb' } } }),
        );
        return {
          exitCode: 1,
          stdout: 'building tiles...\n',
          stderr: 'TileProcessingException: Tileset root node children is null or empty\n',
        };
      });

      const err = await expectRejection(tileGlb(rawGlb, outDir));
      expect(err.message).toContain('exit code 1');
      expect(err.message).toContain('Tileset root node children is null or empty');

      // The short-circuit must happen before mago is ever asked to retry at a different LOD
      // depth -- a crash isn't the "tile too big, back off and retry" case.
      expect(mockedRunMagoTiler).toHaveBeenCalledTimes(1);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('exit 0 with an empty output dir fails as "no tileset.json was produced"', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir) => {
        await fsp.mkdir(outputDir, { recursive: true });
        return { exitCode: 0, stdout: 'done, nothing written\n', stderr: '' };
      });

      const err = await expectRejection(tileGlb(rawGlb, outDir));
      expect(err.message).toContain('no tileset.json was produced');
      expect(err.message).toContain('exit code 0');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('exit 0 with content files but no tileset.json fails as "no tileset.json was produced"', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir) => {
        await fsp.mkdir(outputDir, { recursive: true });
        await fsp.writeFile(path.join(outputDir, 'R0C0000.glb'), Buffer.from([1, 2, 3]));
        await fsp.writeFile(path.join(outputDir, 'R0C0001.glb'), Buffer.from([4, 5, 6]));
        return { exitCode: 0, stdout: 'wrote 2 tiles, no tileset\n', stderr: '' };
      });

      const err = await expectRejection(tileGlb(rawGlb, outDir));
      expect(err.message).toContain('no tileset.json was produced');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('exit 0 with a malformed-JSON tileset.json fails as "tileset.json is malformed"', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir) => {
        await fsp.mkdir(outputDir, { recursive: true });
        await fsp.writeFile(path.join(outputDir, 'tileset.json'), '{ not valid JSON');
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const err = await expectRejection(tileGlb(rawGlb, outDir));
      expect(err.message).toContain('tileset.json is malformed');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('case (b): a tileset.json referencing a missing tile is repaired (regenerated from survivors) and published rather than failed', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir) => {
        await fsp.mkdir(outputDir, { recursive: true });
        await writeTestGlb(path.join(outputDir, 'good.glb'));
        await fsp.writeFile(
          path.join(outputDir, 'tileset.json'),
          JSON.stringify({
            root: { children: [{ content: { uri: 'good.glb' } }, { content: { uri: 'missing.glb' } }] },
          }),
        );
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await tileGlb(rawGlb, outDir);

      const raw = await fsp.readFile(result.tilesetPath, 'utf-8');
      const tileset = JSON.parse(raw) as { root: { children?: { content?: { uri: string } }[]; content?: unknown } };
      expect(tileset.root.children?.map((c) => c.content?.uri)).toEqual(['good.glb']);
      expect(result.warnings.some((w) => w.includes('repaired tileset.json'))).toBe(true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('case (c), zero-content: the exact real-mago shape (well-formed tree, zero content keys) fails as "tileset references no content", and repairTileset is never invoked', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir) => {
        await fsp.mkdir(outputDir, { recursive: true });
        await fsp.writeFile(path.join(outputDir, 'tileset.json'), REAL_MAGO_ZERO_CONTENT_TILESET);
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const err = await expectRejection(tileGlb(rawGlb, outDir));
      expect(err.message).toContain('tileset references no content');
      expect(err.message).toContain('exit code 0');

      // There is nothing referenced for repairTileset to rebuild from -- it must never be
      // invoked for this case, unlike the missing-content case (b) test above.
      expect(mockedRepairTileset).not.toHaveBeenCalled();
      // No retry either: this isn't the "tile too big, back off" case, and repeating the
      // same mago invocation at a lower triangle count wouldn't manufacture content that
      // was never there.
      expect(mockedRunMagoTiler).toHaveBeenCalledTimes(1);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('regression guard: a valid single-content tileset (tileCount === 1) still publishes -- only tileCount === 0 is disqualifying', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir) => {
        await fsp.mkdir(outputDir, { recursive: true });
        await writeTestGlb(path.join(outputDir, 'only.glb'));
        await fsp.writeFile(path.join(outputDir, 'tileset.json'), JSON.stringify({ root: { content: { uri: 'only.glb' } } }));
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await tileGlb(rawGlb, outDir);

      const raw = await fsp.readFile(result.tilesetPath, 'utf-8');
      const tileset = JSON.parse(raw) as { root: { content?: { uri: string } } };
      expect(tileset.root.content?.uri).toBe('only.glb');
      // No repair warning -- this tileset was never broken.
      expect(result.warnings.some((w) => w.includes('repaired tileset.json'))).toBe(false);
      expect(mockedRepairTileset).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('edge: content keys exist but every referenced file is missing -- still routes through the repair path (case (b)), which then fails because nothing survives', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir) => {
        await fsp.mkdir(outputDir, { recursive: true });
        // Content keys are present (unlike the zero-content case above), they just don't
        // resolve to any real file on disk -- referencedCount > 0, tileCount === 0.
        await fsp.writeFile(
          path.join(outputDir, 'tileset.json'),
          JSON.stringify({ root: { children: [{ content: { uri: 'gone-a.glb' } }, { content: { uri: 'gone-b.glb' } }] } }),
        );
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const err = await expectRejection(tileGlb(rawGlb, outDir));

      // Contrast with the zero-content test: this DOES have content references, so repair is
      // attempted (case (b)) -- it just converges to nothing, which is itself a failure.
      expect(mockedRepairTileset).toHaveBeenCalledTimes(1);
      expect(err.message).toMatch(/nothing survives/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
