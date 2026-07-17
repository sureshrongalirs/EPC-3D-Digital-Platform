import type { Database } from '../db/index.js';
import { parseBbox, parseJsonColumn, serializeJsonColumn } from '../lib/json.js';
import type { ArtifactType, ModelDto, ModelRow, RevisionRow, SourceFileRef, TilesSummary } from '../types.js';

export interface ArtifactInfo {
  artifactUrl: string | null;
  artifactType: ArtifactType | null;
  /** Needed (alongside row.id) to derive tilesetUrl/metadataUrl -- both are constructed
   * directly from the id/revision/DATA_DIR convention (matching the existing linkage-map
   * route's own convention), not by string-parsing artifactUrl. */
  revision: number | null;
  tilesSummary: TilesSummary | null;
}

const NO_ARTIFACT: ArtifactInfo = { artifactUrl: null, artifactType: null, revision: null, tilesSummary: null };

export function toModelDto(row: ModelRow, artifact: ArtifactInfo = NO_ARTIFACT): ModelDto {
  const isTiles = artifact.artifactType === 'tiles' && artifact.revision !== null;
  return {
    id: row.id,
    name: row.name,
    sourceFormat: row.source_format,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    currentRevision: row.current_revision,
    bboxMin: parseBbox(row.bbox_min),
    bboxMax: parseBbox(row.bbox_max),
    siteId: row.site_id,
    createdAt: String(row.created_at),
    error: row.error,
    warnings: parseJsonColumn<string[]>(row.warnings) ?? [],
    sourceFiles: parseJsonColumn<SourceFileRef[]>(row.source_files) ?? [],
    artifactUrl: artifact.artifactUrl,
    artifactType: artifact.artifactType,
    renderPath: artifact.artifactType,
    tilesetUrl: isTiles ? artifact.artifactUrl : null,
    metadataUrl: isTiles ? `/files/models/artifacts/${row.id}/${artifact.revision}/metadata.json` : null,
    tilesSummary: artifact.tilesSummary,
  };
}

export interface CreateModelInput {
  id: string;
  name: string;
  sourceFormat: string;
  sizeBytes: number;
  sourceFiles: SourceFileRef[];
  siteId?: string | null;
}

export async function createModel(db: Database, input: CreateModelInput): Promise<ModelRow> {
  await db.knex('models').insert({
    id: input.id,
    name: input.name,
    source_format: input.sourceFormat,
    size_bytes: input.sizeBytes,
    status: 'queued',
    current_revision: null,
    site_id: input.siteId ?? null,
    error: null,
    source_files: serializeJsonColumn(input.sourceFiles),
  });
  const created = await getModelRow(db, input.id);
  if (!created) throw new Error('failed to read back created model');
  return created;
}

export async function getModelRow(db: Database, id: string): Promise<ModelRow | undefined> {
  return db.knex<ModelRow>('models').where({ id }).first();
}

export async function listModelRows(db: Database): Promise<ModelRow[]> {
  return db.knex<ModelRow>('models').orderBy('created_at', 'desc');
}

export async function deleteModel(db: Database, id: string): Promise<number> {
  return db.knex('models').where({ id }).delete();
}

export async function getArtifactPath(
  db: Database,
  modelId: string,
  revision: number | null,
): Promise<string | null> {
  if (revision === null) return null;
  const row = await db.knex<RevisionRow>('revisions').where({ model_id: modelId, revision }).first();
  return row?.artifact_path ?? null;
}

async function getArtifactRevision(
  db: Database,
  modelId: string,
  revision: number | null,
): Promise<Pick<RevisionRow, 'artifact_path' | 'artifact_type' | 'tiles_summary'> | undefined> {
  if (revision === null) return undefined;
  return db.knex<RevisionRow>('revisions').where({ model_id: modelId, revision }).first();
}

export async function toModelDtoWithArtifact(db: Database, row: ModelRow): Promise<ModelDto> {
  const revisionRow = await getArtifactRevision(db, row.id, row.current_revision);
  return toModelDto(row, {
    artifactUrl: revisionRow ? `/files/${revisionRow.artifact_path}` : null,
    artifactType: revisionRow?.artifact_type ?? null,
    revision: revisionRow ? row.current_revision : null,
    tilesSummary: revisionRow ? parseJsonColumn<TilesSummary>(revisionRow.tiles_summary) : null,
  });
}
