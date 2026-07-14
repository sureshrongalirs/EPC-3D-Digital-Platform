import fsp from 'node:fs/promises';
import path from 'node:path';

import { runMagoTiler } from './magoTiler.js';

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

/** mago-3d-tiler's own tile content extensions -- tileset.json itself is excluded from the
 * size check, only actual tile payloads count against the 8MB-per-tile budget.
 *
 * Confirmed against a real run: with -tv 1.1 (3D Tiles 1.1, what this worker always passes --
 * see runMagoTiler()), mago-3d-tiler emits tile content as plain .glb files directly (the 3D
 * Tiles 1.1 "3DTILES_content_gltf" native-glTF-content model), NOT the legacy .b3dm container
 * this list originally assumed. .b3dm/.i3dm/.pnts/.cmpt are kept here too in case a future
 * mago-3d-tiler version or a -tv 1.0 invocation produces them, but .glb is what actually shows
 * up today -- omitting it silently made every tiled model appear to satisfy the 8MB budget
 * regardless of real tile size, since nothing was being checked at all. */
const TILE_CONTENT_EXTENSIONS = new Set(['.b3dm', '.i3dm', '.pnts', '.cmpt', '.glb']);

async function listTileFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTileFiles(full)));
    } else if (TILE_CONTENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
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
    await runMagoTiler(stagingInputDir, tilesOutDir, { maxTriangleCount });

    const tileFiles = await listTileFiles(tilesOutDir);
    const oversized: { file: string; sizeBytes: number }[] = [];
    for (const file of tileFiles) {
      const stat = await fsp.stat(file);
      if (stat.size > MAX_TILE_SIZE_BYTES) oversized.push({ file: path.relative(tilesOutDir, file), sizeBytes: stat.size });
    }

    if (oversized.length === 0) break;

    if (maxTriangleCount <= MIN_MAX_TRIANGLE_COUNT) {
      const summary = oversized.map((o) => `${o.file} (${(o.sizeBytes / (1024 * 1024)).toFixed(1)}MB)`).join(', ');
      warnings.push(
        `${oversized.length} tile(s) exceed the 8MB-per-tile budget even at the minimum LOD depth (maxTriangleCount=${maxTriangleCount}): ${summary}`,
      );
      break;
    }

    maxTriangleCount = Math.max(MIN_MAX_TRIANGLE_COUNT, Math.round(maxTriangleCount * TRIANGLE_COUNT_BACKOFF_FACTOR));
  }

  await fsp.rm(stagingInputDir, { recursive: true, force: true });

  const tilesetPath = path.join(tilesOutDir, 'tileset.json');
  if (!(await fileExists(tilesetPath))) {
    throw new Error(`mago-3d-tiler did not produce a tileset.json at ${tilesetPath}`);
  }

  return { tilesetPath, warnings };
}
