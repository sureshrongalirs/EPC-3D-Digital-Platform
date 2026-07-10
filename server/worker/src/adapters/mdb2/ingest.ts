import type { Database } from '@plantscope/server-shared';
import { serializeJsonColumn } from '@plantscope/server-shared';

import {
  linkageKeyOf,
  Mdb2JoinAccumulator,
  type LabelNameRow,
  type LabelRow,
  type LabelValueRow,
  type LinkageRow,
} from './join.js';
import { readMdbTableFully, streamMdbTable } from './mdbtools.js';

const GIN_INDEX_NAME = 'components_props_gin_idx';
const GIN_INDEX_DDL = `CREATE INDEX ${GIN_INDEX_NAME} ON components USING GIN (props jsonb_path_ops)`;

export interface IngestOptions {
  batchSize?: number;
  /** True when the queue has already claimed exclusive access for this job (see
   * config.ts's WORKER_LARGE_JOB_MB / queue.ts) -- only then is it safe to drop and rebuild
   * the *shared* components table's GIN index around this job's bulk insert, since no other
   * job's inserts can race with it. The index is process-wide (not per-model), so this must
   * never happen for a job running alongside others. */
  exclusiveAccess?: boolean;
}

export interface IngestResult {
  objectCount: number;
  warnings: string[];
}

/**
 * Streams a .mdb2 file's linkage/labels/label_names/label_values tables (via mdbtools),
 * joins them (see join.ts), and bulk-inserts the result into `components`.
 *
 * Memory: linkage/label_names/label_values are lookup tables bounded by object/property-type
 * cardinality and are read fully into Maps; `labels` -- the table that can reach millions of
 * rows for an 800MB+ source file -- is streamed row-by-row via mdb-export | readline and
 * folded directly into the join accumulator, never materialized as an array (CLAUDE.md
 * invariant #4).
 *
 * Inserts are batched via knex's batchInsert (~5,000 rows/statement, matching the task's
 * batch-size target) rather than Postgres COPY: the `pg` driver used here goes through knex
 * uniformly for both dialects (COPY has no SQLite equivalent, and this repo has exactly one
 * Database abstraction for both), and batchInsert already avoids the "buffer everything then
 * one giant INSERT" failure mode this exists to prevent.
 */
export async function ingestMdb2(
  mdbPath: string,
  db: Database,
  modelId: string,
  revision: number,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const batchSize = opts.batchSize ?? 5000;
  const warnings: string[] = [];

  const linkageRows = (await readMdbTableFully(mdbPath, 'linkage')) as unknown as LinkageRow[];
  const labelNameRows = (await readMdbTableFully(mdbPath, 'label_names')) as unknown as LabelNameRow[];
  const labelValueRows = (await readMdbTableFully(mdbPath, 'label_values')) as unknown as LabelValueRow[];

  const linkageById = new Map(linkageRows.map((r) => [r.linkage_id, r]));
  const labelNameById = new Map(labelNameRows.map((r) => [r.label_name_id, r.name]));
  const labelValueById = new Map(labelValueRows.map((r) => [r.label_value_id, r.value]));
  const acc = new Mdb2JoinAccumulator(linkageById, labelNameById, labelValueById);

  for await (const row of streamMdbTable(mdbPath, 'labels')) {
    acc.addLabel(row as unknown as LabelRow);
  }
  acc.includeAllLinkages();

  const dropIndexForBulkLoad = opts.exclusiveAccess === true && db.dialect === 'pg';
  if (dropIndexForBulkLoad) {
    await db.knex.raw(`DROP INDEX IF EXISTS ${GIN_INDEX_NAME}`);
  }

  let batch: Record<string, unknown>[] = [];
  let objectCount = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await db.knex.batchInsert('components', batch, batchSize);
    batch = [];
  };

  for (const component of acc.values()) {
    batch.push({
      model_id: modelId,
      revision,
      linkage_key: component.linkageKey,
      moniker: component.moniker,
      category: component.category,
      props: serializeJsonColumn(component.props),
    });
    objectCount += 1;
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  // Building the index after the bulk load (rather than incrementally maintaining it across
  // thousands of individual inserts) is the whole point of dropping it above.
  if (dropIndexForBulkLoad) {
    await db.knex.raw(GIN_INDEX_DDL);
  }

  if (objectCount === 0) {
    warnings.push('mdb2 ingest produced zero components (empty or unrecognized linkage table)');
  }

  return { objectCount, warnings };
}

export { linkageKeyOf };
