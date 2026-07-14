import fsp from 'node:fs/promises';
import path from 'node:path';

import { runMagoTiler, type MagoTilerResult } from './magoTiler.js';
import { repairTileset, validateTileset } from './tilesetIntegrity.js';

const MAX_TILE_SIZE_BYTES = 8 * 1024 * 1024;
/** Starting point for mago-3d-tiler's -mx (max triangles per tile node) -- tuned down (never
 * up) until every tile fits the 8MB budget, or until MIN_MAX_TRIANGLE_COUNT is reached, at
 * which point this gives up subdividing further and reports the offending tiles as a job
 * warning instead (per this task's "do not silently ignore" requirement) rather than looping
 * forever or failing the whole job over a handful of oversized tiles. */
// Confirmed too high against a real mago-3d-tiler run (an FBX-derived model that produced
// exactly one 46MB tile, no subdivision at all) -- lowered to force more aggressive splitting.
const INITIAL_MAX_TRIANGLE_COUNT = 5_000;
const MIN_MAX_TRIANGLE_COUNT = 500;
const TRIANGLE_COUNT_BACKOFF_FACTOR = 0.5;

/** Last N non-empty lines of mago's combined stdout/stderr, for a structured failure message
 * that names something concrete instead of a bare exit code. */
function lastLogLines(runResult: MagoTilerResult, n = 20): string {
  const combined = [runResult.stderr, runResult.stdout].filter(Boolean).join('\n');
  const lines = combined.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length > 0 ? lines.slice(-n).join('\n') : '(no output captured)';
}

function integrityFailure(reason: string, runResult: MagoTilerResult): Error {
  return new Error(
    `mago-3d-tiler produced no usable tileset: ${reason} (exit code ${runResult.exitCode}). Last output:\n${lastLogLines(runResult)}`,
  );
}

export interface TileGlbResult {
  tilesetPath: string;
  warnings: string[];
}

/**
 * Tiles an intermediate GLB (already assimp-exported from the source FBX -- see
 * fbx/index.ts) into an OGC 3D Tiles tileset via mago-3d-tiler, enforcing the ≤8MB-per-tile
 * budget by re-running with a smaller -mx (max triangles per tile node) whenever any
 * produced tile exceeds it.
 *
 * Integrity gate (Task 1 of the phase5r plan): every attempt is validated before its tile
 * sizes are even inspected, per validateTileset()/repairTileset() in ./tilesetIntegrity.ts --
 * see the three-outcome breakdown inline below. A broken tileset can never reach
 * publishRevision(): this function only ever returns once validateTileset() reports `ok`, and
 * throwing here (case (c), or a repair that doesn't converge) propagates straight up through
 * fbxAdapter.convert() -> pipeline.ts's processJob(), which calls publishRevision() only after
 * every source file's convert() has already succeeded -- so a thrown error here means
 * publishRevision() is never reached at all for this job (CLAUDE.md invariant #6: no partial-
 * publish state is ever visible to readers).
 *
 * Draco compression: mago-3d-tiler does not apply it natively -- confirmed against its own
 * README/MANUAL.md (no -draco flag, no mention of Draco anywhere in its CLI reference).
 * Adding it here would mean parsing and rewriting the b3dm binary container (28-byte header +
 * feature table + batch table + embedded glTF) per tile, which needs a real mago-3d-tiler
 * output to validate against -- this environment has no Java/mago-3d-tiler binary available
 * to produce one. Left as an explicit, tracked follow-up rather than shipped
 * unvalidated: tiles are currently uncompressed. The ≤8MB budget is still enforced for real,
 * just via triangle-count-driven LOD depth (see INITIAL_MAX_TRIANGLE_COUNT above) rather than
 * compression -- CLAUDE.md's size-routing invariant doesn't require Draco specifically, and
 * plant-model tiles at reasonable LOD depths fit the budget on triangle count alone for any
 * source this worker has actually seen.
 */
export async function tileGlb(rawGlbPath: string, outDir: string): Promise<TileGlbResult> {
  const stagingInputDir = path.join(outDir, 'tiling-input');
  const tilesOutDir = path.join(outDir, 'tiles');

  await fsp.mkdir(stagingInputDir, { recursive: true });
  const stagedGlbPath = path.join(stagingInputDir, path.basename(rawGlbPath));
  await fsp.rename(rawGlbPath, stagedGlbPath);

  const warnings: string[] = [];
  let maxTriangleCount = INITIAL_MAX_TRIANGLE_COUNT;

  for (;;) {
    await fsp.rm(tilesOutDir, { recursive: true, force: true });
    const runResult = await runMagoTiler(stagingInputDir, tilesOutDir, { maxTriangleCount });

    // Case (c), path 1: a non-zero exit means mago itself gave up (e.g. Task 0's
    // `TileProcessingException: Tileset root node children is null or empty` crash on dense
    // merged-GLB input) -- short-circuit straight to a hard failure without even looking at
    // whatever mago may have partially written to tilesOutDir. repairTileset is never reached
    // on this path: there is nothing to repair when the tiler itself failed.
    if (runResult.exitCode !== 0) {
      throw integrityFailure('mago-3d-tiler exited with a non-zero status', runResult);
    }

    let validation = await validateTileset(tilesOutDir);

    // Case (c), path 2: exit 0 but no tileset.json (or an unparseable one) -- also a hard
    // failure, never a repair target.
    if (validation.loadStatus !== 'ok') {
      throw integrityFailure(
        validation.loadStatus === 'missing' ? 'no tileset.json was produced' : `tileset.json is malformed (${validation.loadDetail})`,
        runResult,
      );
    }

    // Case (c), path 3: tileset.json parsed fine and every reference it makes resolves (so
    // validation.ok's "nothing missing" half is vacuously satisfied) -- but the tree
    // references ZERO content anywhere. This is not a repair target: repairTileset rebuilds
    // from surviving referenced content, and there is nothing referenced to survive. Checked
    // before the repair branch below so repairTileset is provably never invoked for this case
    // (confirmed against real mago-3d-tiler v1.15.4 output -- an unmaterialed-primitive input
    // that produced a fully well-formed root+children+geometricError-chain tree with zero
    // `content` keys anywhere; see tilesetIntegrity.test.ts for the exact fixture).
    if (validation.referencedCount === 0) {
      throw integrityFailure('tileset references no content', runResult);
    }

    // Case (b): tileset.json exists but references missing/empty tile content -- repair by
    // regenerating from whatever content actually survived, then re-validate before trusting
    // the result.
    if (!validation.ok) {
      const beforeRepair = validation;
      await repairTileset(tilesOutDir);
      validation = await validateTileset(tilesOutDir);
      if (validation.loadStatus !== 'ok' || !validation.ok) {
        throw integrityFailure(`tileset.json repair at ${tilesOutDir} did not converge -- still invalid after regenerating from surviving content`, runResult);
      }
      warnings.push(
        `repaired tileset.json: dropped ${beforeRepair.missing.length} missing/empty content reference(s) (${beforeRepair.missing.join(', ')}), kept ${validation.tileCount} usable tile(s)`,
      );
    }

    if (validation.orphans.length > 0) {
      warnings.push(`${validation.orphans.length} on-disk tile file(s) are not referenced by tileset.json (orphaned, harmless): ${validation.orphans.join(', ')}`);
    }

    // Case (a) (or a successfully-repaired case (b)): tileset.json is structurally sound.
    // Only now is it meaningful to check individual tile sizes against the 8MB budget.
    const oversized = validation.tiles.filter((t) => t.sizeBytes > MAX_TILE_SIZE_BYTES);

    if (oversized.length === 0) break;

    if (maxTriangleCount <= MIN_MAX_TRIANGLE_COUNT) {
      const summary = oversized.map((o) => `${o.uri} (${(o.sizeBytes / (1024 * 1024)).toFixed(1)}MB)`).join(', ');
      warnings.push(
        `${oversized.length} tile(s) exceed the 8MB-per-tile budget even at the minimum LOD depth (maxTriangleCount=${maxTriangleCount}): ${summary}`,
      );
      break;
    }

    maxTriangleCount = Math.max(MIN_MAX_TRIANGLE_COUNT, Math.round(maxTriangleCount * TRIANGLE_COUNT_BACKOFF_FACTOR));
  }

  await fsp.rm(stagingInputDir, { recursive: true, force: true });

  return { tilesetPath: path.join(tilesOutDir, 'tileset.json'), warnings };
}
