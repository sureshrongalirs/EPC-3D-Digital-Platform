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
  /** Whether the FBX adapter Draco-compresses its GLB output (env: WORKER_DRACO_FOR_CESIUM,
   * default false). Cesium's built-in Draco decoder hangs silently (model.ready never
   * becomes true, flyToBoundingSphere never runs) on GLBs produced by
   * @gltf-transform/functions' draco() + draco3dgltf's encoder -- a version/encoding
   * mismatch between that encoder and Cesium's bundled decoder. Single-GLB artifacts are
   * served straight to @plantscope/globe-view's Cesium.Model, so compression is skipped by
   * default and correctness (the model actually rendering) wins over file size. Draco only
   * matters for the OGC 3D Tiles path (Phase 5, not yet built) where tile size is critical;
   * this flag exists so that path (or a future fix to the decoder mismatch) can turn
   * compression back on without code changes. */
  dracoForCesium: boolean;
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
    sizeThresholdMb: Number(env['SIZE_THRESHOLD_MB'] ?? '50'),
    pollIntervalMs: Number(env['WORKER_POLL_INTERVAL_MS'] ?? '2000'),
    dracoForCesium: env['WORKER_DRACO_FOR_CESIUM'] === 'true',
  };
}
