import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { streamCsvRows } from './csv.js';

export class MdbToolsUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`mdbtools binaries (mdb-tables/mdb-export) are not available: ${String(cause)}`);
    this.name = 'MdbToolsUnavailableError';
  }
}

/** Streams one mdb-export table as parsed CSV row objects, without ever buffering the raw
 * output -- readline yields line-by-line from the child process's stdout, and streamCsvRows
 * turns each line into a row as it arrives. Rejects with MdbToolsUnavailableError if
 * mdb-export itself can't be spawned (binary missing), which callers use to distinguish
 * "not installed" from "this file is malformed" and to gate the E2E test's skip logic. */
export async function* streamMdbTable(mdbPath: string, table: string): AsyncGenerator<Record<string, string>> {
  const child = spawn('mdb-export', [mdbPath, table], { stdio: ['ignore', 'pipe', 'pipe'] });

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.once('error', (err) => resolve(err));
    child.once('spawn', () => resolve(null));
  });
  if (spawnError) throw new MdbToolsUnavailableError(spawnError);

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  yield* streamCsvRows(rl);

  const exitCode = await new Promise<number>((resolve) => {
    child.once('close', (code) => resolve(code ?? 0));
  });
  if (exitCode !== 0) {
    throw new Error(`mdb-export ${mdbPath} ${table} exited with code ${exitCode}: ${stderr.trim()}`);
  }
}

export async function readMdbTableFully(mdbPath: string, table: string): Promise<Record<string, string>[]> {
  const rows: Record<string, string>[] = [];
  for await (const row of streamMdbTable(mdbPath, table)) rows.push(row);
  return rows;
}

/** Cheap availability probe (used by the E2E test's skip-if-absent gate and by
 * scripts/verify-local.sh) -- distinct from actually reading a real .mdb2 file. Any exit
 * (even a usage error from a bogus path argument) proves the binary is installed; only a
 * spawn-level ENOENT means it isn't. */
export async function isMdbToolsAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('mdb-tables', ['--nonexistent-probe-path'], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', () => resolve(true));
  });
}
