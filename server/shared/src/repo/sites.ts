import type { Database } from '../db/index.js';
import type { SiteDto, SiteRow } from '../types.js';

export function toSiteDto(row: SiteRow): SiteDto {
  return {
    id: row.id,
    name: row.name,
    rotationDeg: row.rotation_deg,
    anchorConvention: row.anchor_convention,
    heightDatum: row.height_datum,
    updatedAt: String(row.updated_at),
  };
}

export interface CreateSiteInput {
  id: string;
  name: string;
  rotationDeg?: number | null;
}

export async function createSite(db: Database, input: CreateSiteInput): Promise<SiteRow> {
  await db.knex('sites').insert({
    id: input.id,
    name: input.name,
    rotation_deg: input.rotationDeg ?? null,
  });
  const created = await getSiteRow(db, input.id);
  if (!created) throw new Error('failed to read back created site');
  return created;
}

export async function getSiteRow(db: Database, id: string): Promise<SiteRow | undefined> {
  return db.knex<SiteRow>('sites').where({ id }).first();
}

export async function listSiteRows(db: Database): Promise<SiteRow[]> {
  return db.knex<SiteRow>('sites').orderBy('name');
}

export interface UpdateSiteRotationResult {
  site: SiteRow;
  affectedModelsCount: number;
}

/**
 * PATCH /api/sites/{id} = "save as site default" (CLAUDE.md: propagation only happens via
 * this one explicit action, never automatically). Updates the site's rotation, then
 * re-resolves every OTHER model at this site whose georef isn't itself overridden
 * (rotation_source != 'model_override') so it immediately reflects the new site value
 * with rotation_source='site_inherited'.
 */
export async function updateSiteRotation(
  db: Database,
  id: string,
  rotationDeg: number,
): Promise<UpdateSiteRotationResult | null> {
  return db.knex.transaction(async (trx) => {
    const existing = await trx<SiteRow>('sites').where({ id }).first();
    if (!existing) return null;

    await trx('sites').where({ id }).update({ rotation_deg: rotationDeg, updated_at: trx.fn.now() });
    const site = (await trx<SiteRow>('sites').where({ id }).first()) as SiteRow;

    const affectedModelsCount = await trx('georefs')
      .where({ site_id: id })
      .whereNot({ rotation_source: 'model_override' })
      .update({ rotation_deg: rotationDeg, rotation_source: 'site_inherited', updated_at: trx.fn.now() });

    return { site, affectedModelsCount };
  });
}
