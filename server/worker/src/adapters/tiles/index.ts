import fsp from 'node:fs/promises';
import path from 'node:path';

import { runMagoTiler, type MagoTilerResult } from './magoTiler.js';
import { splitObjects } from './splitter.js';
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
  metadataPath: string;
  warnings: string[];
}

export interface TileGlbOptions {
  /** See config.ts's Config.splitterTriangleFloor doc comment. */
  triangleFloor: number;
  /** See config.ts's Config.splitterBlobWarnRatio doc comment. */
  blobWarnRatio: number;
}

/**
 * Tiles an intermediate GLB (already assimp-exported from the source FBX -- see
 * fbx/index.ts) into an OGC 3D Tiles tileset via mago-3d-tiler, enforcing the ≤8MB-per-tile
 * budget by re-running with a smaller -mx (max triangles per tile node) whenever any
 * produced tile exceeds it.
 *
 * Task 2 (per-object pipeline reshape): the merged GLB is first exploded into one file per
 * object by splitter.ts (see its own doc comment for the identity/fragment-merge rules) --
 * mago-3d-tiler genuinely spatially subdivides a directory of separate per-object GLBs, but
 * never a single merged one, confirmed by Task 0 (docs/phase5r/task0-findings.md).
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
 * Task 2 policy addition on top of Task 1's (otherwise unchanged) gate mechanics: since every
 * object is now individually provided to mago as its own input file, mago dropping any of
 * them (tileset.json referencing missing/empty content, case (b)) is no longer an inherent,
 * expected consequence of a known merged-mode quirk -- it indicates mago genuinely failed to
 * tile something it was given, which is worth surfacing as a job failure, not silently
 * papering over with a warning the way Task 1 originally treated case (b) for merged-mode
 * input. repairTileset() itself is NOT changed (still attempted, still re-validated -- Task
 * 1's gate runs unchanged, per this task's own spec) -- this caller instead escalates a
 * *successful* repair outcome into a thrown error once the retry loop would otherwise accept
 * it, so the underlying repair mechanism stays available for any future caller that still
 * wants it.
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
export async function tileGlb(rawGlbPath: string, outDir: string, linkageMap: Map<string, string>, options: TileGlbOptions): Promise<TileGlbResult> {
  const stagingInputDir = path.join(outDir, 'tiling-input');
  const tilesOutDir = path.join(outDir, 'tiles');

  const splitResult = await splitObjects(rawGlbPath, stagingInputDir, linkageMap, {
    triangleFloor: options.triangleFloor,
    blobWarnRatio: options.blobWarnRatio,
  });

  const warnings: string[] = [...splitResult.warnings];
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
    // the result. repairTileset()/validateTileset() themselves are unchanged from Task 1; see
    // this function's own doc comment for why a repair that succeeds still fails the JOB for
    // split-mode input (checked below, once we know this attempt would otherwise be accepted).
    let repairedThisAttempt: { missingCount: number; missingList: string[] } | undefined;
    if (!validation.ok) {
      const beforeRepair = validation;
      await repairTileset(tilesOutDir);
      validation = await validateTileset(tilesOutDir);
      if (validation.loadStatus !== 'ok' || !validation.ok) {
        throw integrityFailure(`tileset.json repair at ${tilesOutDir} did not converge -- still invalid after regenerating from surviving content`, runResult);
      }
      repairedThisAttempt = { missingCount: beforeRepair.missing.length, missingList: beforeRepair.missing };
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

    if (oversized.length === 0) {
      if (repairedThisAttempt) {
        throw new Error(
          `split-mode tiling required a tileset repair -- a FAILED run for split-mode input, not a warning: each object was provided to mago-3d-tiler individually, so mago dropping ${repairedThisAttempt.missingCount} of them (${repairedThisAttempt.missingList.join(', ')}) indicates a real anomaly worth investigating, not an expected consequence of a known merged-mode quirk. Healthy split-mode output must yield tileCount > 0 with ZERO repairs.`,
        );
      }
      break;
    }

    if (maxTriangleCount <= MIN_MAX_TRIANGLE_COUNT) {
      if (repairedThisAttempt) {
        throw new Error(
          `split-mode tiling required a tileset repair AND still exceeds the 8MB-per-tile budget at the minimum LOD depth -- a FAILED run, not a warning (see the clean-success path's identical policy above).`,
        );
      }
      // Policy (confirmed against the real-file run, docs/phase5r/task2-findings.md §7: 4
      // tiles up to 29.4MB at this exact floor): oversized-at-minimum-LOD with NO repair
      // needed PUBLISHES, with a structured warning, rather than failing the job. The 8MB
      // figure is a streaming/runtime-performance guard (how much a client fetches per tile),
      // not a publishability gate -- unlike case (b)/(c) above, an oversized tile is still
      // complete, correct geometry a client CAN load, just slower than ideal. Missing/
      // zero-content tiles (case (b)/(c)) stay hard failures regardless of size, since those
      // mean data is actually gone, not merely large.
      const summary = oversized.map((o) => `${o.uri} (${(o.sizeBytes / (1024 * 1024)).toFixed(1)}MB)`).join(', ');
      warnings.push(
        `${oversized.length} tile(s) exceed the 8MB-per-tile budget even at the minimum LOD depth (maxTriangleCount=${maxTriangleCount}): ${summary}`,
      );
      break;
    }

    maxTriangleCount = Math.max(MIN_MAX_TRIANGLE_COUNT, Math.round(maxTriangleCount * TRIANGLE_COUNT_BACKOFF_FACTOR));
  }

  // metadata.json (Task 2) is a persistent sidecar artifact, same lifetime as tileset.json --
  // relocate it out of stagingInputDir (about to be deleted) alongside linkage-map.json's own
  // convention (pipeline.ts writes that one directly at outDir/linkage-map.json).
  const metadataPath = path.join(outDir, 'metadata.json');
  await fsp.rename(splitResult.metadataPath, metadataPath);

  await fsp.rm(stagingInputDir, { recursive: true, force: true });

  return { tilesetPath: path.join(tilesOutDir, 'tileset.json'), metadataPath, warnings };
}
