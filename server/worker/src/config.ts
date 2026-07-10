import path from 'node:path';

export interface Config {
  dataDir: string;
  modelsRawDir: string;
  modelsArtifactsDir: string;
  databaseUrl: string;
  parallelism: number;
  stallTimeoutMs: number;
  largeJobMb: number;
  sizeThresholdMb: number;
  pollIntervalMs: number;
}

/**
 * Pure — mirrors server/api's config.ts loadConfig (does not read `.env` itself; that's
 * dotenv/config's job, imported once in src/index.ts) so tests can pass a plain env object.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env['DATA_DIR'] ?? './data');
  const databaseUrl = env['DATABASE_URL'] ?? path.join(dataDir, 'dev.sqlite3');

  return {
    dataDir,
    // CLAUDE.md invariant #5: binaries live under /data/models; DB stores only pointers.
    modelsRawDir: path.join(dataDir, 'models', 'raw'),
    modelsArtifactsDir: path.join(dataDir, 'models', 'artifacts'),
    databaseUrl,
    parallelism: Number(env['WORKER_PARALLELISM'] ?? '2'),
    stallTimeoutMs: Number(env['WORKER_STALL_TIMEOUT_MS'] ?? String(10 * 60 * 1000)),
    largeJobMb: Number(env['WORKER_LARGE_JOB_MB'] ?? '250'),
    sizeThresholdMb: Number(env['SIZE_THRESHOLD_MB'] ?? '100'),
    pollIntervalMs: Number(env['WORKER_POLL_INTERVAL_MS'] ?? '2000'),
  };
}
