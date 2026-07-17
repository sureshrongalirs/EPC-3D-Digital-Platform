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

/** A minimal, real, parseable GLB -- Task 2's splitter genuinely parses `rawGlbPath` now (it's
 * no longer a blind rename), and repairTileset() (case (b)) separately reads actual GLB
 * geometry to compute a bounding volume, so no test fixture in this file can be arbitrary
 * bytes the way it could before Task 2. */
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

async function makeRawGlb(dir: string): Promise<string> {
  const rawGlbPath = path.join(dir, 'model.glb');
  await writeTestGlb(rawGlbPath);
  return rawGlbPath;
}

/** A valid, parseable GLB (repairTileset() reads real POSITION data via gltf-transform's
 * getBounds() -- see tilesetIntegrity.ts) whose on-disk size exceeds the 8MB tile budget, via
 * many repeated (degenerate is fine -- bounding-box math doesn't need unique geometry)
 * triangles rather than padding raw bytes onto an otherwise-valid file. */
async function writeOversizedTestGlb(glbPath: string): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const triangleCount = 250_000; // 250k * 3 verts * 3 floats * 4 bytes ~= 9MB of POSITION data alone
  const positions = new Float32Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const base = t * 9;
    positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0], base);
    indices.set([t * 3, t * 3 + 1, t * 3 + 2], t * 3);
  }
  const positionAccessor = doc.createAccessor('positions').setType('VEC3').setArray(positions).setBuffer(buffer);
  const indexAccessor = doc.createAccessor('indices').setType('SCALAR').setArray(indices).setBuffer(buffer);
  const primitive = doc.createPrimitive().setAttribute('POSITION', positionAccessor).setIndices(indexAccessor);
  const mesh = doc.createMesh('BigMesh').addPrimitive(primitive);
  const node = doc.createNode('BigMesh').setMesh(mesh);
  doc.createScene('Scene').addChild(node);
  await new NodeIO().write(glbPath, doc);
}

const NO_LINKAGE_MAP = new Map<string, string>();
const DEFAULT_SPLIT_OPTIONS = { triangleFloor: 50, blobWarnRatio: 0.5, inputSizeBytes: 1_000_000 };

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

      const err = await expectRejection(tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS));
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

      const err = await expectRejection(tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS));
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

      const err = await expectRejection(tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS));
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

      const err = await expectRejection(tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS));
      expect(err.message).toContain('tileset.json is malformed');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('case (b), Task 2 policy: a tileset.json referencing a missing tile still repairs successfully at the tilesetIntegrity.ts layer (repairTileset really does regenerate from survivors), but tileGlb() escalates that success into a job failure -- split-mode input should never need repair', async () => {
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

      const err = await expectRejection(tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS));

      // repairTileset() itself was called and genuinely succeeded (Task 1's mechanism is
      // unchanged) -- the failure is tileGlb()'s own policy escalation on top, not a
      // repairTileset()/tilesetIntegrity.ts regression.
      expect(mockedRepairTileset).toHaveBeenCalledTimes(1);
      expect(err.message).toContain('split-mode tiling required a tileset repair');
      expect(err.message).toContain('FAILED run for split-mode input, not a warning');
      expect(err.message).toContain('missing.glb');
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

      const err = await expectRejection(tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS));
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

  it('policy: an oversized tile that persists at the minimum LOD depth, with NO repair needed, PUBLISHES with a structured warning rather than failing the job', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');
      // Every call to mago-3d-tiler returns exactly one, always-oversized (>8MB) tile,
      // regardless of the -mx value tileGlb() retries with -- deterministically forces the
      // backoff loop all the way down to MIN_MAX_TRIANGLE_COUNT (500) and the "give up" branch.
      const oversizedContent = Buffer.alloc(9 * 1024 * 1024, 1);

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir) => {
        await fsp.mkdir(outputDir, { recursive: true });
        await fsp.writeFile(path.join(outputDir, 'big.glb'), oversizedContent);
        await fsp.writeFile(path.join(outputDir, 'tileset.json'), JSON.stringify({ root: { content: { uri: 'big.glb' } } }));
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS);

      // Published: tilesetPath exists and points at the (still oversized) real tile.
      const raw = await fsp.readFile(result.tilesetPath, 'utf-8');
      const tileset = JSON.parse(raw) as { root: { content?: { uri: string } } };
      expect(tileset.root.content?.uri).toBe('big.glb');

      // Structured warning, not silence -- names the offending tile and its size.
      const warning = result.warnings.find((w) => w.includes('exceed the 8MB-per-tile budget'));
      expect(warning).toBeDefined();
      expect(warning).toContain('big.glb');
      expect(warning).toContain('maxTriangleCount=500'); // MIN_MAX_TRIANGLE_COUNT, confirms the floor was reached

      // No repair was needed for this tileset (content present, just large) -- the repair-
      // escalates-to-failure policy (case (b) test above) must not have fired here.
      expect(mockedRepairTileset).not.toHaveBeenCalled();

      // Backoff actually happened -- more than one attempt before giving up at the floor.
      expect(mockedRunMagoTiler.mock.calls.length).toBeGreaterThan(1);
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

      const result = await tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS);

      const raw = await fsp.readFile(result.tilesetPath, 'utf-8');
      const tileset = JSON.parse(raw) as { root: { content?: { uri: string } } };
      expect(tileset.root.content?.uri).toBe('only.glb');
      // No repair warning -- this tileset was never broken.
      expect(result.warnings.some((w) => w.includes('repaired tileset.json'))).toBe(false);
      expect(mockedRepairTileset).not.toHaveBeenCalled();
      // PR #14 verification fix-up: repairFired at the summary level, healthy-path half of
      // the true/false pair (the repair-fired case is its own test below).
      expect(result.summary.repairFired).toBe(false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('edge: content keys exist but every referenced file is missing -- still routes through the repair path (case (b)), which then fails via repairTileset\'s own pre-repair guard (validation.tiles.length === 0 at entry, before it ever attempts to write anything)', async () => {
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

      const err = await expectRejection(tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS));

      // Contrast with the zero-content test: this DOES have content references, so repair is
      // attempted (case (b)) -- it just converges to nothing, which is itself a failure. This
      // message ("nothing survives") is repairTileset's OWN early-guard error
      // (tilesetIntegrity.ts's `if (validation.tiles.length === 0) throw ...`, fired BEFORE
      // any write), not index.ts's post-repair integrityFailure() -- that message says "did
      // not converge" instead (see the next test, which isolates that other path
      // specifically). Both are real, hard failures; they're just two different guards.
      expect(mockedRepairTileset).toHaveBeenCalledTimes(1);
      expect(err.message).toMatch(/nothing survives/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('defense in depth: if repairTileset ever returned without throwing despite leaving zero surviving tiles, index.ts\'s OWN post-repair re-validation independently catches it and never publishes', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir) => {
        await fsp.mkdir(outputDir, { recursive: true });
        // A single missing reference -- ok:false, so the repair branch (case (b)) is entered.
        await fsp.writeFile(path.join(outputDir, 'tileset.json'), JSON.stringify({ root: { content: { uri: 'gone.glb' } } }));
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      // The REAL repairTileset can never reach "returned normally but left zero tiles" (its
      // own guard above throws first whenever it would). This override simulates that
      // hypothetical anyway, to prove index.ts doesn't blindly trust repairTileset's success --
      // it independently re-validates the file repairTileset actually wrote, using the exact
      // same tileCount > 0 rule.
      mockedRepairTileset.mockImplementationOnce(async (repairOutputDir: string) => {
        await fsp.writeFile(path.join(repairOutputDir, 'tileset.json'), JSON.stringify({ root: {} }));
        return { kept: [], dropped: ['gone.glb'] };
      });

      const err = await expectRejection(tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS));

      expect(mockedRepairTileset).toHaveBeenCalledTimes(1);
      // This message comes from index.ts's own post-repair check, not repairTileset -- the
      // opposite half of the previous test's contrast.
      expect(err.message).toContain('did not converge');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  // PR #14 verification fix-up (verdict FAIL: repairFired's own computation was untested at
  // the tileGlb() level -- only a hardcoded mock value in fbx/index.test.ts existed). Every
  // OTHER repair-triggering test in this file escalates straight to a thrown error (Task 2's
  // split-mode policy: a repair on the attempt that's about to be ACCEPTED is a hard failure),
  // so none of them ever reach the `return {..., summary}` success path at all. This test
  // constructs the one case that does: attempt 1 (maxTriangleCount 5000, the initial value)
  // needs a repair AND is still oversized afterward, so the loop backs off and retries rather
  // than accepting or throwing (repairFiredEver latches true here, `repairedThisAttempt` itself
  // is NOT carried to the next loop iteration); attempt 2 (maxTriangleCount 2500) is clean --
  // no missing refs, not oversized -- so it's accepted without ever needing repair. The
  // published result must still report repairFired: true, proving the flag reflects the whole
  // job's history, not just the final accepted attempt.
  it('repairFired reflects the WHOLE job: true even when only an earlier (non-final) attempt needed a repair', async () => {
    const dir = await makeTempDir();
    try {
      const rawGlb = await makeRawGlb(dir);
      const outDir = path.join(dir, 'out');

      mockedRunMagoTiler.mockImplementation(async (_inputDir, outputDir, opts) => {
        await fsp.mkdir(outputDir, { recursive: true });
        if (opts.maxTriangleCount === 5000) {
          // Attempt 1: references a missing tile (triggers repair) AND the surviving tile is
          // oversized (>8MB) -- repair succeeds but the result still can't be accepted, so
          // the loop must back off and retry rather than accept-with-repair or throw.
          await writeOversizedTestGlb(path.join(outputDir, 'good.glb'));
          await fsp.writeFile(
            path.join(outputDir, 'tileset.json'),
            JSON.stringify({
              root: { children: [{ content: { uri: 'good.glb' } }, { content: { uri: 'missing.glb' } }] },
            }),
          );
        } else {
          // Attempt 2 (backed off to maxTriangleCount 2500): clean, small, no missing refs --
          // accepted without any repair this time.
          await writeTestGlb(path.join(outputDir, 'small.glb'));
          await fsp.writeFile(path.join(outputDir, 'tileset.json'), JSON.stringify({ root: { content: { uri: 'small.glb' } } }));
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await tileGlb(rawGlb, outDir, NO_LINKAGE_MAP, DEFAULT_SPLIT_OPTIONS);

      expect(mockedRepairTileset).toHaveBeenCalledTimes(1); // only attempt 1 ever needed it
      expect(mockedRunMagoTiler.mock.calls.length).toBe(2); // attempt 1 (repaired, still oversized) -> attempt 2 (accepted)

      const raw = await fsp.readFile(result.tilesetPath, 'utf-8');
      const tileset = JSON.parse(raw) as { root: { content?: { uri: string } } };
      expect(tileset.root.content?.uri).toBe('small.glb'); // the FINAL (attempt 2) tileset, not attempt 1's

      expect(result.summary.repairFired).toBe(true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
