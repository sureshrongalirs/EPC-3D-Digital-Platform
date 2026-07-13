export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface BoundingBox {
  min: Vector3Like;
  max: Vector3Like;
}

export interface ObjectSummary {
  id: string;
  name: string;
}

export interface TreeNode {
  id: string;
  name: string;
  children: TreeNode[];
}

export interface PickResult {
  objectId: string;
  point: Vector3Like;
  distance: number;
  screen: ScreenPoint;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** 'glb'/'gltf' are both handled by the same GLTFLoader-based code path; 'tiles' is the
   * OGC 3D Tiles / 3DTilesRendererJS backend for models over CLAUDE.md invariant #4's size
   * threshold. Callers of Viewer.loadModel() never choose this -- it just reports which
   * backend the server told the Viewer to use. */
  format: 'glb' | 'gltf' | 'tiles';
  /** For 'tiles', this is the count of entries in the model's linkage-map sidecar (the best
   * available proxy for "identifiable objects" -- tiles stream in/out dynamically, so there
   * is no single fixed per-object registry the way the GLB path has), or 0 if the model has
   * no linkage map. */
  objectCount: number;
  bbox: BoundingBox;
}

/**
 * A 2D point in a horizontal-plane projection. Producers (e.g. @plantscope/core's
 * `getObjectBounds`) map this to world X/Z (three.js is Y-up); consumers (zone footprints,
 * the local-tangent-plane georef math below) agree on that same convention.
 */
export interface Point2D {
  x: number;
  y: number;
}

export interface Zone {
  id: string;
  name: string;
  color: string;
  /** Resolved, cached object ids — see ZonesPlugin's definition/boundary/members model. */
  members: string[];
  /** 2D convex hull over all members' world bbox corners, in the X/Z plane. */
  footprint: Point2D[];
  /** World Y range (vertical) spanning all members' bboxes. */
  zmin: number;
  zmax: number;
}

/** Trustworthiness of a georeference — see CLAUDE.md "Georeferencing invariants". */
export type GeorefMethod = 'assumed' | 'provided' | 'provided+adjusted' | 'surveyed' | 'authoritative';

/** Provenance of a model's rotation — kept separate from `method` per CLAUDE.md. */
export type RotationSource = 'model_override' | 'site_inherited' | 'default';

export type HeightDatum = 'ellipsoidal' | 'orthometric' | 'unknown';

/** Which point of the model's local space `anchorLat`/`anchorLon` corresponds to. */
export type AnchorConvention = 'model_origin' | 'model_centroid';

export interface GeorefRecord {
  modelId: string;
  siteId: string | null;
  anchorLat: number;
  anchorLon: number;
  height: number | null;
  heightDatum: HeightDatum;
  rotationDeg: number;
  rotationSource: RotationSource;
  method: GeorefMethod;
  anchorConvention: AnchorConvention;
}

/** Engineering-properties record joined via the Linkage key (see CLAUDE.md invariant #3). */
export interface ComponentRecord {
  linkageKey: string;
  moniker: string;
  category: string;
  tagNumber: string;
  status: string;
}

export function createEmptyBoundingBox(): BoundingBox {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
}

export function expandBoundingBox(box: BoundingBox, point: Vector3Like): BoundingBox {
  return {
    min: {
      x: Math.min(box.min.x, point.x),
      y: Math.min(box.min.y, point.y),
      z: Math.min(box.min.z, point.z),
    },
    max: {
      x: Math.max(box.max.x, point.x),
      y: Math.max(box.max.y, point.y),
      z: Math.max(box.max.z, point.z),
    },
  };
}

export function mergeBoundingBoxes(a: BoundingBox, b: BoundingBox): BoundingBox {
  return expandBoundingBox(expandBoundingBox(a, b.min), b.max);
}

export function boundingBoxCenter(box: BoundingBox): Vector3Like {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
}

// ---------------------------------------------------------------------------
// 2D convex hull (Andrew's monotone chain) — used for Zone footprints.
// ---------------------------------------------------------------------------

function cross(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Returns the convex hull of `points` in counter-clockwise order, starting from the
 * lowest-then-leftmost point, with no duplicate closing point. Collinear points on an edge
 * are dropped. Degenerate inputs (0-2 distinct points) are returned deduplicated, as-is.
 */
export function computeConvexHull2D(points: readonly Point2D[]): Point2D[] {
  const unique = Array.from(new Map(points.map((p) => [`${p.x}:${p.y}`, p])).values()).sort(
    (a, b) => a.x - b.x || a.y - b.y,
  );

  if (unique.length <= 2) return unique;

  const lower: Point2D[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point2D[] = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const p = unique[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Shoelace formula. Result is unsigned (always >= 0), regardless of winding order. */
export function polygonArea(points: readonly Point2D[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

// ---------------------------------------------------------------------------
// Local tangent-plane <-> lat/lon conversion, for MapGeorefPlugin.
// ---------------------------------------------------------------------------

export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_378_137; // WGS84 semi-major axis
const DEG_TO_RAD = Math.PI / 180;

function metersPerDegreeLat(): number {
  return DEG_TO_RAD * EARTH_RADIUS_M;
}

function metersPerDegreeLon(atLatDeg: number): number {
  return DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(atLatDeg * DEG_TO_RAD);
}

/**
 * Projects a local-space 2D point (meters, X/Z plane) to lat/lon using a flat-earth local
 * tangent-plane approximation centered on `anchor`, rotated by `rotationDeg` (degrees
 * clockwise from north that the model's local +Y axis points). Good to sub-meter accuracy
 * over plant-model-scale extents (up to a few km) — not a substitute for a real geodetic
 * projection at larger scale.
 */
export function localToLatLon(local: Point2D, anchor: LatLon, rotationDeg: number): LatLon {
  const theta = rotationDeg * DEG_TO_RAD;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const east = local.x * cos + local.y * sin;
  const north = -local.x * sin + local.y * cos;

  return {
    lat: anchor.lat + north / metersPerDegreeLat(),
    lon: anchor.lon + east / metersPerDegreeLon(anchor.lat),
  };
}

/** Exact inverse of {@link localToLatLon} for the same `anchor`/`rotationDeg`. */
export function latLonToLocal(point: LatLon, anchor: LatLon, rotationDeg: number): Point2D {
  const east = (point.lon - anchor.lon) * metersPerDegreeLon(anchor.lat);
  const north = (point.lat - anchor.lat) * metersPerDegreeLat();
  const theta = rotationDeg * DEG_TO_RAD;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  return {
    x: east * cos - north * sin,
    y: east * sin + north * cos,
  };
}

// ---------------------------------------------------------------------------
// Trigram similarity — used by LinkageMetadataPlugin's fuzzy-match tier.
// ---------------------------------------------------------------------------

function trigrams(value: string): Set<string> {
  const padded = `  ${value.toLowerCase()}  `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/** Dice coefficient over character trigrams (same idea as PostgreSQL's pg_trgm), in [0, 1]. */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const gramsA = trigrams(a);
  const gramsB = trigrams(b);
  if (gramsA.size === 0 || gramsB.size === 0) return 0;

  let intersection = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersection += 1;
  }
  return (2 * intersection) / (gramsA.size + gramsB.size);
}

export interface TrigramMatch<T> {
  candidate: T;
  score: number;
}

/** Best-scoring candidate at or above `threshold`, or `null` if none qualifies. */
export function findBestTrigramMatch<T>(
  query: string,
  candidates: readonly T[],
  candidateText: (candidate: T) => string,
  threshold = 0.3,
): TrigramMatch<T> | null {
  let best: TrigramMatch<T> | null = null;
  for (const candidate of candidates) {
    const score = trigramSimilarity(query, candidateText(candidate));
    if (score >= threshold && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }
  return best;
}
