import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class AssimpUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`assimp binary is not available: ${String(cause)}`);
    this.name = 'AssimpUnavailableError';
  }
}

export async function isAssimpAvailable(): Promise<boolean> {
  try {
    await execFileAsync('assimp', ['version']);
    return true;
  } catch (err) {
    // A non-zero exit from "version" still proves the binary launched; only ENOENT (no
    // such binary) means assimp truly isn't installed.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Shells out to `assimp export in.fbx out.glb` -- the geometry half of the FBX adapter.
 * assimp (like every standard FBX loader) discards the custom "Linkages" Properties70
 * entries, which is exactly why parseFBXLinkages() exists as a separate raw-binary pass
 * (CLAUDE.md invariant #3); this call handles geometry only. */
export async function assimpExport(inputPath: string, outputPath: string): Promise<void> {
  try {
    await execFileAsync('assimp', ['export', inputPath, outputPath]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AssimpUnavailableError(err);
    throw new Error(`assimp export ${inputPath} -> ${outputPath} failed: ${String(err)}`);
  }
}

/** Parses the "Faces:" count out of `assimp info <path>` -- used as the triangle-count
 * parity check between the FBX source and the exported GLB (assimp triangulates on export,
 * so face count === triangle count for both sides of the comparison). */
export async function assimpFaceCount(filePath: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('assimp', ['info', filePath]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AssimpUnavailableError(err);
    throw new Error(`assimp info ${filePath} failed: ${String(err)}`);
  }

  const match = /^\s*Faces:\s*(\d+)/m.exec(stdout);
  if (!match) throw new Error(`could not parse face count from "assimp info ${filePath}" output`);
  return Number(match[1]);
}
