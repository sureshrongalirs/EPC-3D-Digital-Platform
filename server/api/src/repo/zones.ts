import type { Database } from '../db/index.js';
import { parseJsonColumn, serializeJsonColumn } from '../lib/json.js';
import type { ZoneDto, ZoneMemberRow, ZoneRow } from '../types.js';

export function toZoneDto(row: ZoneRow): ZoneDto {
  return {
    id: row.id,
    modelId: row.model_id,
    name: row.name,
    color: row.color,
    footprintLocal: parseJsonColumn(row.footprint_local) ?? [],
    zmin: row.zmin,
    zmax: row.zmax,
  };
}

export interface CreateZoneInput {
  id: string;
  modelId: string;
  name: string;
  color: string;
  footprintLocal: { x: number; y: number }[];
  zmin: number;
  zmax: number;
  /**
   * NOTE: ZonesPlugin (packages/plugins) currently sends the viewer's raw object ids here,
   * not real Linkage keys (that translation needs LinkageMetadataPlugin's sidecar map,
   * which ZonesPlugin doesn't consult) — a known gap, not fixed by this phase. We store
   * whatever string we're given as `linkage_key` so the endpoint contract itself is
   * correct; the semantic mismatch is called out in the PR.
   */
  memberLinkageKeys: string[];
  memberRevision: number;
}

/**
 * Upsert by id: ZonesPlugin POSTs to this same endpoint for create, rename, recolor,
 * add-members, and remove-member alike (see packages/plugins/src/zones/ZonesPlugin.ts),
 * always sending the full current zone state. Existing members are replaced wholesale
 * rather than diffed — simpler, and correct since the plugin always sends the complete set.
 */
export async function upsertZone(db: Database, input: CreateZoneInput): Promise<ZoneRow> {
  return db.knex.transaction(async (trx) => {
    const existing = await trx<ZoneRow>('zones').where({ id: input.id }).first();
    const values = {
      name: input.name,
      color: input.color,
      footprint_local: serializeJsonColumn(input.footprintLocal),
      zmin: input.zmin,
      zmax: input.zmax,
    };

    if (existing) {
      await trx('zones').where({ id: input.id }).update(values);
      await trx('zone_members').where({ zone_id: input.id }).delete();
    } else {
      await trx('zones').insert({ id: input.id, model_id: input.modelId, ...values });
    }

    if (input.memberLinkageKeys.length > 0) {
      await trx('zone_members').insert(
        input.memberLinkageKeys.map((linkageKey) => ({
          zone_id: input.id,
          linkage_key: linkageKey,
          revision: input.memberRevision,
        })),
      );
    }

    const saved = await trx<ZoneRow>('zones').where({ id: input.id }).first();
    if (!saved) throw new Error('failed to read back zone');
    return saved;
  });
}

export async function listZoneRows(db: Database, modelId?: string): Promise<ZoneRow[]> {
  const query = db.knex<ZoneRow>('zones');
  if (modelId) query.where({ model_id: modelId });
  return query.orderBy('name');
}

export async function getZoneRow(db: Database, id: string): Promise<ZoneRow | undefined> {
  return db.knex<ZoneRow>('zones').where({ id }).first();
}

export async function getZoneMembers(db: Database, zoneId: string): Promise<ZoneMemberRow[]> {
  return db.knex<ZoneMemberRow>('zone_members').where({ zone_id: zoneId });
}

export async function deleteZone(db: Database, id: string): Promise<number> {
  return db.knex('zones').where({ id }).delete();
}
