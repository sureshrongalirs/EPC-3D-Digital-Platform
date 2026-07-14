import fsp from 'node:fs/promises';
import path from 'node:path';

import { NodeIO, getBounds } from '@gltf-transform/core';

/** Minimal shape this module actually reads/writes -- a real tileset.json has many more
 * OGC 3D Tiles fields that pass through `[key: string]: unknown` untouched. */
export interface BoundingVolume {
  box?: number[];
  region?: number[];
  sphere?: number[];
  [key: string]: unknown;
}

export interface TileNode {
  boundingVolume?: BoundingVolume;
  geometricError?: number;
  refine?: 'ADD' | 'REPLACE';
  content?: { uri?: string; url?: string };
  contents?: { uri?: string; url?: string }[];
  children?: TileNode[];
  [key: string]: unknown;
}

export interface TilesetJson {
  asset?: { version: string; [key: string]: unknown };
  geometricError?: number;
  root: TileNode;
  [key: string]: unknown;
}

export type TilesetLoadResult =
  | { status: 'missing' }
  | { status: 'malformed'; detail: string }
  | { status: 'ok'; tileset: TilesetJson };

const TILESET_FILENAME = 'tileset.json';

/** mago-3d-tiler's own tile content extensions. With -tv 1.1 (always used -- see
 * magoTiler.ts), content is emitted as plain .glb files (3D Tiles 1.1's native-glTF-content
 * model), not the legacy .b3dm container; the rest are kept in case a future version or a
 * -tv 1.0 invocation produces them. */
const TILE_CONTENT_EXTENSIONS = new Set(['.b3dm', '.i3dm', '.pnts', '.cmpt', '.glb']);

/** Case (c) detection (missing/unparseable). Deliberately does not distinguish "directory
 * doesn't exist" from "tileset.json doesn't exist" -- both mean mago produced no usable
 * output, which is all the caller needs to know. */
export async function loadTileset(tilesOutDir: string): Promise<TilesetLoadResult> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(tilesOutDir, TILESET_FILENAME), 'utf-8');
  } catch {
    return { status: 'missing' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'malformed', detail: err instanceof Error ? err.message : String(err) };
  }

  if (!parsed || typeof parsed !== 'object' || !('root' in parsed) || !(parsed as { root: unknown }).root) {
    return { status: 'malformed', detail: 'tileset.json has no root node' };
  }
  return { status: 'ok', tileset: parsed as TilesetJson };
}

/** A forward-slash-joined path relative to `base`, for comparing tileset.json URIs (always
 * posix-style per the 3D Tiles spec) against real filesystem paths (which may use `\` on
 * Windows dev/CI machines). */
function toPosixRelative(base: string, full: string): string {
  return path.relative(base, full).split(path.sep).join('/');
}

async function listOnDiskContentFiles(dir: string, baseDir: string = dir): Promise<string[]> {
  const out: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listOnDiskContentFiles(full, baseDir)));
    } else if (TILE_CONTENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(toPosixRelative(baseDir, full));
    }
  }
  return out;
}

function collectContentUris(node: TileNode | undefined, out: Set<string>): void {
  if (!node) return;
  const single = node.content?.uri ?? node.content?.url;
  if (single) out.add(single);
  for (const c of node.contents ?? []) {
    const uri = c.uri ?? c.url;
    if (uri) out.add(uri);
  }
  for (const child of node.children ?? []) collectContentUris(child, out);
}

export interface ValidatedTile {
  uri: string;
  sizeBytes: number;
}

export interface TilesetValidationResult {
  /** True only when tileset.json parsed with a root node AND every content reference it
   * makes resolves to a real, non-empty file on disk. */
  ok: boolean;
  loadStatus: TilesetLoadResult['status'];
  /** Present only when loadStatus === 'malformed'. */
  loadDetail?: string;
  /** Content URIs the tree references that are not present on disk, or are present but
   * zero bytes -- either way, unusable. */
  missing: string[];
  /** On-disk tile-content files under outputDir that no tile in the tree references --
   * informational only, never a validation failure on their own. */
  orphans: string[];
  /** Every referenced, present, non-empty tile, with its real size. */
  tiles: ValidatedTile[];
  tileCount: number;
  totalBytes: number;
  maxTileBytes: number;
}

/**
 * Task 1 item 1: parses tileset.json, walks the full tile tree (all content/contents URIs,
 * all children, recursively), and verifies every referenced content file exists on disk and
 * is non-empty. On-disk tile-content files the tree never references are reported as
 * `orphans` (a warning-level signal -- never on their own a reason to fail or repair).
 */
export async function validateTileset(outputDir: string): Promise<TilesetValidationResult> {
  const loaded = await loadTileset(outputDir);
  if (loaded.status !== 'ok') {
    return {
      ok: false,
      loadStatus: loaded.status,
      loadDetail: loaded.status === 'malformed' ? loaded.detail : undefined,
      missing: [],
      orphans: [],
      tiles: [],
      tileCount: 0,
      totalBytes: 0,
      maxTileBytes: 0,
    };
  }

  const referencedUris = new Set<string>();
  collectContentUris(loaded.tileset.root, referencedUris);

  const missing: string[] = [];
  const tiles: ValidatedTile[] = [];
  for (const uri of referencedUris) {
    try {
      const stat = await fsp.stat(path.join(outputDir, uri));
      if (stat.size === 0) missing.push(uri);
      else tiles.push({ uri, sizeBytes: stat.size });
    } catch {
      missing.push(uri);
    }
  }

  const onDisk = await listOnDiskContentFiles(outputDir);
  const referenced = new Set(referencedUris);
  const orphans = onDisk.filter((f) => !referenced.has(f));

  const totalBytes = tiles.reduce((sum, t) => sum + t.sizeBytes, 0);
  const maxTileBytes = tiles.reduce((max, t) => Math.max(max, t.sizeBytes), 0);

  return {
    ok: missing.length === 0,
    loadStatus: 'ok',
    missing,
    orphans,
    tiles,
    tileCount: tiles.length,
    totalBytes,
    maxTileBytes,
  };
}

async function computeGlbBoundsBox(absPath: string): Promise<{ min: [number, number, number]; max: [number, number, number] }> {
  const doc = await new NodeIO().read(absPath);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) throw new Error(`${absPath} has no scene to compute a bounding box from`);
  const { min, max } = getBounds(scene);
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

/** A small floor on box half-extents so a degenerate (single-point or perfectly flat) mesh
 * still produces a non-zero-volume bounding box -- zero-extent boxes are a known source of
 * culling/picking glitches in 3D Tiles clients. */
const MIN_HALF_EXTENT = 1e-3;

function bboxToTilesBox(min: [number, number, number], max: [number, number, number]): number[] {
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const hx = Math.max((max[0] - min[0]) / 2, MIN_HALF_EXTENT);
  const hy = Math.max((max[1] - min[1]) / 2, MIN_HALF_EXTENT);
  const hz = Math.max((max[2] - min[2]) / 2, MIN_HALF_EXTENT);
  // 3D Tiles "box": center (3) + half-axis vectors for x, y, z (3x3), axis-aligned here.
  return [cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz];
}

function unionBounds(
  a: { min: [number, number, number]; max: [number, number, number] } | undefined,
  b: { min: [number, number, number]; max: [number, number, number] },
): { min: [number, number, number]; max: [number, number, number] } {
  if (!a) return b;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

function diagonalLength(min: [number, number, number], max: [number, number, number]): number {
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export interface RepairResult {
  /** Tile content URIs kept in the regenerated tileset. */
  kept: string[];
  /** Tile content URIs the broken tileset referenced but that were dropped (missing/empty). */
  dropped: string[];
}

/**
 * Task 1 item 2 (repair): regenerates a minimal, spec-valid tileset.json referencing ONLY
 * files that actually exist on disk, overwriting the broken one at
 * `{outputDir}/tileset.json`.
 *
 * Deliberately does not try to patch the broken tree in place (e.g. by trusting its own
 * per-tile bounding volumes) -- the broken tileset is exactly the artifact we can no longer
 * trust, so every surviving tile's bounding volume is recomputed directly from its own GLB's
 * real geometry via `@gltf-transform/core`'s `getBounds` (already a dependency, used the same
 * way draco.ts already reads GLBs -- no new heavyweight dependency). The regenerated shape is
 * a flat root -> per-tile-content children tree (root has no content of its own, `refine:
 * "ADD"`, geometricError = the union bounding box's diagonal so any reasonable camera
 * distance triggers refinement into the real content; each child's geometricError is 0, since
 * it *is* the finest available detail for that content -- Task 2's per-object splitter is
 * what will later give this real LOD structure).
 *
 * Never invoked for case (c): there is no tileset.json to repair when mago produced none, or
 * produced only an unparseable one -- see index.ts's integrity gate, which only calls this
 * after validateTileset() has confirmed loadStatus === 'ok'.
 */
export async function repairTileset(outputDir: string): Promise<RepairResult> {
  const validation = await validateTileset(outputDir);
  if (validation.loadStatus !== 'ok') {
    throw new Error(`repairTileset(${outputDir}) called with no valid tileset.json to repair (loadStatus=${validation.loadStatus}) -- there is nothing to repair`);
  }
  if (validation.tiles.length === 0) {
    throw new Error(`repairTileset(${outputDir}): zero referenced content files exist on disk -- nothing survives to rebuild a tileset from`);
  }

  const children: TileNode[] = [];
  let unionBox: { min: [number, number, number]; max: [number, number, number] } | undefined;

  for (const tile of validation.tiles) {
    const bounds = await computeGlbBoundsBox(path.join(outputDir, tile.uri));
    children.push({
      boundingVolume: { box: bboxToTilesBox(bounds.min, bounds.max) },
      geometricError: 0,
      content: { uri: tile.uri },
    });
    unionBox = unionBounds(unionBox, bounds);
  }

  const rootGeometricError = diagonalLength(unionBox!.min, unionBox!.max);
  const tileset: TilesetJson = {
    asset: { version: '1.1' },
    geometricError: rootGeometricError,
    root: {
      boundingVolume: { box: bboxToTilesBox(unionBox!.min, unionBox!.max) },
      geometricError: rootGeometricError,
      refine: 'ADD',
      children,
    },
  };

  await writeTileset(outputDir, tileset);

  return { kept: validation.tiles.map((t) => t.uri), dropped: [...validation.missing] };
}

export async function writeTileset(outputDir: string, tileset: TilesetJson): Promise<void> {
  await fsp.writeFile(path.join(outputDir, TILESET_FILENAME), JSON.stringify(tileset, null, 2));
}
