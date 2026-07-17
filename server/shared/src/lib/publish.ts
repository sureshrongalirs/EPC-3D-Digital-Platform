import type { Knex } from 'knex';

import type { Database } from '../db/index.js';
import { serializeJsonColumn } from '../lib/json.js';
import type { TilesSummary } from '../types.js';

export interface PublishParams {
  modelId: string;
  revision: number;
  artifactType: 'glb' | 'tiles';
  artifactPath: string;
  /** Task 3 deliverable 4 -- see TilesSummary's own doc comment. Only meaningful for
   * artifactType 'tiles'; omitted (stored null) otherwise. */
  tilesSummary?: TilesSummary;
}

export interface PublishOptions {
  /**
   * Test-only seam: runs inside the same transaction, between the revision insert and the
   * current_revision flip. If it throws, the entire transaction (including the revision
   * insert) rolls back — this is what makes the atomicity guarantee itself directly
   * testable (see publish.test.ts) without needing to fabricate a real constraint
   * violation on the second statement.
   */
  afterRevisionInsert?: (trx: Knex.Transaction) => Promise<void> | void;
}

/**
 * Atomic publish (CLAUDE.md invariant #6): one transaction writes the new revision row
 * and flips `models.current_revision` (and status -> 'ready'). Exposed as its own module,
 * not inlined into a route handler, so the Phase 4 worker can call it verbatim.
 */
export async function publishRevision(
  db: Database,
  params: PublishParams,
  options: PublishOptions = {},
): Promise<void> {
  await db.knex.transaction(async (trx) => {
    await trx('revisions').insert({
      model_id: params.modelId,
      revision: params.revision,
      artifact_type: params.artifactType,
      artifact_path: params.artifactPath,
      tiles_summary: params.tilesSummary ? serializeJsonColumn(params.tilesSummary) : null,
    });

    if (options.afterRevisionInsert) {
      await options.afterRevisionInsert(trx);
    }

    await trx('models').where({ id: params.modelId }).update({
      current_revision: params.revision,
      status: 'ready',
    });
  });
}
