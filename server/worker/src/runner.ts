import type { Database, ModelRow } from '@plantscope/server-shared';
import type { Logger } from 'pino';

import { adaptersByKind, glbAdapter } from './adapters/registry.js';
import type { Config } from './config.js';
import { processJob } from './pipeline.js';
import { claimJobs, reclaimStalledJobs } from './queue.js';

/** Best-effort peak-memory estimate for a whole job (summed across its source files) --
 * used to decide whether this job must claim the queue exclusively (config.largeJobMb). Errors
 * here (e.g. a missing/corrupt file) are swallowed; the real error surfaces from processJob. */
async function estimateJobMemoryMB(config: Config, model: ModelRow): Promise<number> {
  try {
    const sourceFiles = JSON.parse(model.source_files) as { kind: string; path: string }[];
    let total = 0;
    for (const file of sourceFiles) {
      const absolutePath = `${config.dataDir}/${file.path}`;
      const adapter = adaptersByKind[file.kind as keyof typeof adaptersByKind] ?? glbAdapter;
      const probe = await adapter.probe(absolutePath);
      total += probe.estimatedPeakMemoryMB;
    }
    return total;
  } catch {
    return 0;
  }
}

async function runOneJob(db: Database, config: Config, logger: Logger, model: ModelRow): Promise<void> {
  const jobLogger = logger.child({ modelId: model.id });
  try {
    await processJob(db, config, jobLogger, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jobLogger.error({ err }, 'job failed');
    await db.knex('models').where({ id: model.id }).update({ status: 'failed', error: message, processing_started_at: null });
    return;
  }
  await db.knex('models').where({ id: model.id }).update({ processing_started_at: null });
}

export interface WorkerLoopHandle {
  stop: () => Promise<void>;
}

/**
 * The queue's scheduling loop: reclaims stalled jobs, then claims and runs jobs up to
 * config.parallelism concurrently -- except a job whose estimated peak memory is at or above
 * config.largeJobMb, which is held until no other job is active and then run alone (probe-
 * based adaptive parallelism, per the task spec), after which normal concurrent claiming
 * resumes.
 */
export function startWorkerLoop(db: Database, config: Config, logger: Logger): WorkerLoopHandle {
  let stopped = false;
  const active = new Map<string, Promise<void>>();

  const loop = (async () => {
    while (!stopped) {
      await reclaimStalledJobs(db, config.stallTimeoutMs, logger);

      const availableSlots = config.parallelism - active.size;
      if (availableSlots > 0 && active.size === 0) {
        const claimed = await claimJobs(db, availableSlots);
        for (const model of claimed) {
          const memoryMB = await estimateJobMemoryMB(config, model);
          if (memoryMB >= config.largeJobMb) {
            // Exclusive: run alone, blocking new claims until it finishes.
            await runOneJob(db, config, logger, model);
          } else {
            const promise = runOneJob(db, config, logger, model).finally(() => active.delete(model.id));
            active.set(model.id, promise);
          }
        }
      } else if (availableSlots > 0) {
        const claimed = await claimJobs(db, availableSlots);
        for (const model of claimed) {
          const memoryMB = await estimateJobMemoryMB(config, model);
          if (memoryMB >= config.largeJobMb) {
            // Can't start an exclusive job while others are active; put it back and wait.
            await db.knex('models').where({ id: model.id }).update({ status: 'queued', processing_started_at: null });
            continue;
          }
          const promise = runOneJob(db, config, logger, model).finally(() => active.delete(model.id));
          active.set(model.id, promise);
        }
      }

      if (active.size > 0) {
        await Promise.race([...active.values(), new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs))]);
      } else {
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
      }
    }
    await Promise.all(active.values());
  })();

  return {
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}
