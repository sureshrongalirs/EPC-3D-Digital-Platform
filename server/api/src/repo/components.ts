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
