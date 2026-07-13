import type { Database } from '../db/index.js';
import { parseBbox, parseJsonColumn } from '../lib/json.js';
import type { ComponentDto, ComponentRow } from '../types.js';

export function toComponentDto(row: ComponentRow): ComponentDto {
  return {
    modelId: row.model_id,
    revision: row.revision,
    linkageKey: row.linkage_key,
    moniker: row.moniker,
    category: row.category,
    props: parseJsonColumn(row.props),
    bboxMin: parseBbox(row.bbox_min),
    bboxMax: parseBbox(row.bbox_max),
  };
}

/** GET /api/components/{key}?model={id} — joined engineering properties, latest revision. */
export async function getComponent(
  db: Database,
  modelId: string,
  linkageKey: string,
): Promise<ComponentRow | undefined> {
  return db
    .knex<ComponentRow>('components')
    .where({ model_id: modelId, linkage_key: linkageKey })
    .orderBy('revision', 'desc')
    .first();
}

export interface ComponentBbox {
  linkageKey: string;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
}

/** GET /api/components?model={id}&fields=bbox -- every component's bbox for one model
 * revision in a single query, used by @plantscope/core's Viewer to compute
 * getObjectScreenCentroids() for OGC 3D Tiles models (whose objects may span tiles that
 * aren't currently loaded/streamed in, so their centroids can't be read off any live
 * three.js geometry the way the GLB path does -- see CLAUDE.md invariant #4). */
export async function listComponentBboxesByModel(db: Database, modelId: string, revision: number): Promise<ComponentBbox[]> {
  const rows = await db
    .knex<ComponentRow>('components')
    .where({ model_id: modelId, revision })
    .select('linkage_key', 'bbox_min', 'bbox_max');

  return rows.map((row) => ({
    linkageKey: row.linkage_key,
    bboxMin: parseBbox(row.bbox_min),
    bboxMax: parseBbox(row.bbox_max),
  }));
}
