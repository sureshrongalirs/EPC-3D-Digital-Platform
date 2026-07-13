// Public API of @plantscope/server-shared: the DB layer + business logic that both
// server/api and server/worker must share rather than reimplement. In particular,
// publishRevision (atomic publish, CLAUDE.md invariant #6) and resolveRotation (rotation
// precedence, CLAUDE.md's Georeferencing invariants) are called verbatim by the worker —
// see the Phase 4 PR for why this package exists at all.

export { closeDatabase, createDatabase, initDatabase, type Database, type Dialect } from './db/index.js';
export { runMigrations } from './db/migrations.js';

export {
  parseBbox,
  parseJsonColumn,
  serializeBbox,
  serializeJsonColumn,
  type Bbox,
} from './lib/json.js';
export { publishRevision, type PublishOptions, type PublishParams } from './lib/publish.js';
export {
  resolveRotation,
  type ResolvedRotation,
  type RotationSource as ResolvedRotationSource,
} from './lib/rotationPrecedence.js';

export {
  getArtifactPath,
  createModel,
  deleteModel,
  getModelRow,
  listModelRows,
  toModelDto,
  toModelDtoWithArtifact,
  type CreateModelInput,
} from './repo/models.js';
export {
  createSite,
  getSiteRow,
  listSiteRows,
  toSiteDto,
  updateSiteRotation,
  type CreateSiteInput,
  type UpdateSiteRotationResult,
} from './repo/sites.js';
export {
  getGeorefRow,
  resetGeoref,
  toGeorefDto,
  upsertGeoref,
  type UpsertGeorefInput,
} from './repo/georef.js';
export { getComponent, listComponentBboxesByModel, toComponentDto, type ComponentBbox } from './repo/components.js';
export {
  deleteZone,
  getZoneMembers,
  getZoneRow,
  listZoneRows,
  toZoneDto,
  upsertZone,
  type CreateZoneInput,
} from './repo/zones.js';
export { recordAudit, type AuditEntry } from './repo/audit.js';

export type {
  AnchorConvention,
  ArtifactType,
  ComponentDto,
  ComponentRow,
  GeorefDto,
  GeorefMethod,
  GeorefRow,
  HeightDatum,
  ModelDto,
  ModelRow,
  ModelStatus,
  RevisionRow,
  RotationSource,
  SiteDto,
  SiteRow,
  SourceFileRef,
  ZoneDto,
  ZoneMemberRow,
  ZoneRow,
} from './types.js';
