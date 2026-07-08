import type { Database, ModelRow } from '@plantscope/server-shared';
import type { Logger } from 'pino';

/** Returns rows stuck in 'processing' past the stall timeout to 'queued' -- the crash-safety
 * half of the queue (a worker that dies mid-job leaves no other signal behind). Runs once per
 * poll tick, before claiming new work, so a stalled row is immediately eligible again. */
export async function reclaimStalledJobs(db: Database, stallTimeoutMs: number, logger: Logger): Promise<number> {
  const cutoff = new Date(Date.now() - stallTimeoutMs);
  const reclaimed = await db
    .knex<ModelRow>('models')
    .where({ status: 'processing' })
    .where('processing_started_at', '<', cutoff.toISOString())
    .update({ status: 'queued', processing_started_at: null });

  if (reclaimed > 0) logger.warn({ reclaimed }, 'reclaimed stalled job(s) back to queued');
  return reclaimed;
}

/**
 * Claims up to `limit` queued rows with SELECT ... FOR UPDATE SKIP LOCKED, flipping them to
 * 'processing' in the same transaction. SKIP LOCKED is what makes this safe with N worker
 * processes polling the same table concurrently: two workers racing for the same row never
 * both win it, and neither blocks waiting on a row already claimed elsewhere.
 *
 * SQLite (used for local dev/tests) has no row-level locking or FOR UPDATE SKIP LOCKED --
 * knex silently ignores those clauses there, but since better-sqlite3 is synchronous and
 * single-connection, one query at a time is already exclusive by construction, so the
 * concurrency guarantee still holds for the case that actually matters (multiple *workers*),
 * just via a different mechanism than Postgres.
 */
export async function claimJobs(db: Database, limit: number): Promise<ModelRow[]> {
  return db.knex.transaction(async (trx) => {
    const query = trx<ModelRow>('models').where({ status: 'queued' }).orderBy('created_at', 'asc').limit(limit);
    if (db.dialect === 'pg') query.forUpdate().skipLocked();
    const rows = await query;

    if (rows.length === 0) return [];

    const processingStartedAt = new Date().toISOString();
    await trx('models')
      .whereIn(
        'id',
        rows.map((r) => r.id),
      )
      .update({ status: 'processing', processing_started_at: processingStartedAt });

    return rows.map((row) => ({ ...row, status: 'processing' as const, processing_started_at: processingStartedAt }));
  });
}
