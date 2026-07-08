import path from 'node:path';

export interface Config {
  dataDir: string;
  modelsRawDir: string;
  modelsArtifactsDir: string;
  databaseUrl: string;
  maxUploadBytes: number;
  port: number;
}

/**
 * Pure — does not read `.env` itself (that's `dotenv/config`'s job, imported once in
 * src/index.ts) so tests can pass a plain env object without touching the filesystem.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env['DATA_DIR'] ?? './data');
  const databaseUrl = env['DATABASE_URL'] ?? path.join(dataDir, 'dev.sqlite3');
  const maxUploadMb = Number(env['MAX_UPLOAD_MB'] ?? '1024');
  const port = Number(env['PORT'] ?? '3000');

  return {
    dataDir,
    // CLAUDE.md invariant #5: binaries live under /data/models; DB stores only pointers.
    modelsRawDir: path.join(dataDir, 'models', 'raw'),
    modelsArtifactsDir: path.join(dataDir, 'models', 'artifacts'),
    databaseUrl,
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    port,
  };
}
