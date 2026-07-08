import type { Database } from '../db/index.js';
import { resolveRotation } from '../lib/rotationPrecedence.js';
import type { AnchorConvention, GeorefDto, GeorefMethod, GeorefRow, HeightDatum } from '../types.js';

export function toGeorefDto(row: GeorefRow): GeorefDto {
  return {
    modelId: row.model_id,
    revision: row.revision,
    siteId: row.site_id,
    anchorLat: row.anchor_lat,
    anchorLon: row.anchor_lon,
    height: row.height,
    heightDatum: row.height_datum,
    rotationDeg: row.rotation_deg,
    rotationSource: row.rotation_source,
    method: row.method,
    anchorConvention: row.anchor_convention,
    updatedAt: String(row.updated_at),
  };
}

export async function getGeorefRow(db: Database, modelId: string): Promise<GeorefRow | undefined> {
  return db.knex<GeorefRow>('georefs').where({ model_id: modelId }).first();
}

export interface UpsertGeorefInput {
  anchorLat: number;
  anchorLon: number;
  height?: number | null;
  heightDatum?: HeightDatum;
  /** Omitted (undefined/null) -> resolved via site inheritance/default, not model_override. */
  rotationDeg?: number | null;
  method?: GeorefMethod;
  anchorConvention?: AnchorConvention;
}

/** POST /api/models/{id}/georef — upsert, with rotation precedence resolved here (write time). */
export async function upsertGeoref(
  db: Database,
  modelId: string,
  siteId: string | null,
  currentRevision: number | null,
  input: UpsertGeorefInput,
): Promise<GeorefRow> {
  const { rotationDeg, rotationSource } = await resolveRotation(db, siteId, input.rotationDeg ?? null);

  const row = {
    model_id: modelId,
    revision: currentRevision ?? 0,
    site_id: siteId,
    anchor_lat: input.anchorLat,
    anchor_lon: input.anchorLon,
    height: input.height ?? null,
    height_datum: input.heightDatum ?? 'unknown',
    rotation_deg: rotationDeg,
    rotation_source: rotationSource,
    method: input.method ?? 'provided',
    anchor_convention: input.anchorConvention ?? 'model_origin',
    updated_at: db.knex.fn.now(),
  };

  const existing = await getGeorefRow(db, modelId);
  if (existing) {
    await db.knex('georefs').where({ model_id: modelId }).update(row);
  } else {
    await db.knex('georefs').insert(row);
  }

  const saved = await getGeorefRow(db, modelId);
  if (!saved) throw new Error('failed to read back georef');
  return saved;
}

/** POST /api/models/{id}/georef/reset — clears the model-level override, re-resolves. */
export async function resetGeoref(
  db: Database,
  modelId: string,
  siteId: string | null,
): Promise<GeorefRow | null> {
  const existing = await getGeorefRow(db, modelId);
  if (!existing) return null;

  const { rotationDeg, rotationSource } = await resolveRotation(db, siteId, null);
  await db.knex('georefs').where({ model_id: modelId }).update({
    rotation_deg: rotationDeg,
    rotation_source: rotationSource,
    updated_at: db.knex.fn.now(),
  });

  const saved = await getGeorefRow(db, modelId);
  if (!saved) throw new Error('failed to read back georef after reset');
  return saved;
}
