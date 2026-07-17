export type ModelStatus = 'queued' | 'processing' | 'ready' | 'failed';
export type ArtifactType = 'glb' | 'tiles';
export type HeightDatum = 'ellipsoidal' | 'orthometric' | 'unknown';
export type RotationSource = 'model_override' | 'site_inherited' | 'default';
export type GeorefMethod = 'assumed' | 'provided' | 'provided+adjusted' | 'surveyed' | 'authoritative';
export type AnchorConvention = 'model_origin' | 'model_centroid';

export interface SourceFileRef {
  kind: 'fbx' | 'mdb2' | 'llh' | 'other';
  path: string;
  originalName: string;
}

export interface ModelRow {
  id: string;
  name: string;
  source_format: string;
  size_bytes: string | number;
  status: ModelStatus;
  current_revision: number | null;
  bbox_min: string | null;
  bbox_max: string | null;
  site_id: string | null;
  created_at: string;
  error: string | null;
  source_files: string;
  processing_started_at: string | null;
  warnings: string | null;
}

export interface ModelDto {
  id: string;
  name: string;
  sourceFormat: string;
  sizeBytes: number;
  status: ModelStatus;
  currentRevision: number | null;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
  siteId: string | null;
  createdAt: string;
  error: string | null;
  warnings: string[];
  sourceFiles: SourceFileRef[];
  artifactUrl: string | null;
  /** null until a revision is published (mirrors artifactUrl's own null-until-published
   * lifecycle) -- lets @plantscope/core's Viewer.loadModel() route between GLTFLoader and
   * the OGC 3D Tiles renderer without guessing from the URL's extension. */
  artifactType: ArtifactType | null;
  /** Same value as artifactType -- Task 3's client-facing name for the same routing
   * decision. Both are kept (rather than renaming artifactType) since artifactType is
   * already referenced by selectLoadBackend/tests/CLAUDE.md's own Phase 5 notes. */
  renderPath: ArtifactType | null;
  /** For renderPath 'tiles' only: the tileset.json URL (today identical to artifactUrl,
   * named for what a tiles-aware client actually wants rather than overloading one field
   * for two backends). Null for 'glb' or an unpublished model. */
  tilesetUrl: string | null;
  /** For renderPath 'tiles' only: Task 2's metadata.json sidecar (per-object identity --
   * name/path/kind/linkageKey/triangleCount/mergedFrom), served via GET
   * /api/models/{id}/metadata. Null for 'glb' or an unpublished model. */
  metadataUrl: string | null;
  /** Task 3 deliverable 4 -- see TilesSummary's own doc comment. */
  tilesSummary: TilesSummary | null;
}

/** Ops-visibility summary for a tiles job (Task 3 deliverable 4) -- null for a 'glb'
 * revision, or a 'tiles' revision published before this field existed. */
export interface TilesSummary {
  inputSizeBytes: number;
  objectCount: number;
  tileCount: number;
  maxTileBytes: number;
  durationMs: number;
  repairFired: boolean;
}

export interface RevisionRow {
  model_id: string;
  revision: number;
  artifact_type: ArtifactType;
  artifact_path: string;
  published_at: string;
  tiles_summary: string | null;
}

export interface ComponentRow {
  model_id: string;
  revision: number;
  linkage_key: string;
  moniker: string | null;
  category: string | null;
  props: unknown;
  bbox_min: string | null;
  bbox_max: string | null;
}

export interface ComponentDto {
  modelId: string;
  revision: number;
  linkageKey: string;
  moniker: string | null;
  category: string | null;
  props: Record<string, unknown> | null;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
}

export interface ZoneRow {
  id: string;
  model_id: string;
  name: string;
  color: string;
  footprint_local: string;
  zmin: number;
  zmax: number;
}

export interface ZoneDto {
  id: string;
  modelId: string;
  name: string;
  color: string;
  footprintLocal: { x: number; y: number }[];
  zmin: number;
  zmax: number;
}

export interface ZoneMemberRow {
  zone_id: string;
  linkage_key: string;
  revision: number;
}

export interface SiteRow {
  id: string;
  name: string;
  rotation_deg: number | null;
  anchor_convention: AnchorConvention;
  height_datum: HeightDatum | null;
  updated_at: string;
  updated_by: string | null;
}

export interface SiteDto {
  id: string;
  name: string;
  rotationDeg: number | null;
  anchorConvention: AnchorConvention;
  heightDatum: HeightDatum | null;
  updatedAt: string;
}

export interface GeorefRow {
  model_id: string;
  revision: number;
  site_id: string | null;
  anchor_lat: number;
  anchor_lon: number;
  height: number | null;
  height_datum: HeightDatum;
  rotation_deg: number;
  rotation_source: RotationSource;
  method: GeorefMethod;
  anchor_convention: AnchorConvention;
  updated_at: string;
}

export interface GeorefDto {
  modelId: string;
  revision: number;
  siteId: string | null;
  anchorLat: number;
  anchorLon: number;
  height: number | null;
  heightDatum: HeightDatum;
  rotationDeg: number;
  rotationSource: RotationSource;
  method: GeorefMethod;
  anchorConvention: AnchorConvention;
  updatedAt: string;
}
