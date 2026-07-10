import type { Database } from '../db/index.js';
import { parseBbox, parseJsonColumn, serializeJsonColumn } from '../lib/json.js';
import type { ModelDto, ModelRow, RevisionRow, SourceFileRef } from '../types.js';

export function toModelDto(row: ModelRow, artifactUrl: string | null): ModelDto {
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
    artifactUrl,
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

export async function toModelDtoWithArtifact(db: Database, row: ModelRow): Promise<ModelDto> {
  const artifactPath = await getArtifactPath(db, row.id, row.current_revision);
  return toModelDto(row, artifactPath ? `/files/${artifactPath}` : null);
}
