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
  format: 'glb';
  objectCount: number;
  bbox: BoundingBox;
}

export interface Zone {
  id: string;
  name: string;
  objectIds: string[];
}

/** Trustworthiness of a georeference — see CLAUDE.md "Georeferencing invariants". */
export type GeorefMethod = 'assumed' | 'provided' | 'provided+adjusted' | 'surveyed' | 'authoritative';

/** Provenance of a model's rotation — kept separate from `method` per CLAUDE.md. */
export type RotationSource = 'model_override' | 'site_inherited' | 'default';

export type HeightDatum = 'ellipsoidal' | 'orthometric' | 'unknown';

export interface GeorefRecord {
  latitude: number;
  longitude: number;
  height: number;
  rotationDeg: number;
  method: GeorefMethod;
  rotationSource: RotationSource;
  heightDatum: HeightDatum;
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
