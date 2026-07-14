import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * mago-3d-tiler (Gaia3D, MPL-2.0, github.com/Gaia3D/mago-3d-tiler) is the OGC 3D Tiles
 * generator this worker shells out to. There is no npm package for it -- it's a Java 21+
 * CLI tool, distributed as a JAR (or a Docker image wrapping the same JAR). A per-job Docker
 * container invocation was ruled out: CLAUDE.md invariant #7 requires this worker's own
 * container to have no outbound network access and to stay within the single docker-compose
 * stack (no extra orchestrated service) -- spinning up a sibling container per tiling job
 * would violate both. Instead the JAR (and a portable Eclipse Temurin JRE 21 tarball, since
 * Debian bookworm's own apt repos only go up to OpenJDK 17) are baked into this worker's own
 * Docker image at build time (see server/worker/Dockerfile), exactly mirroring how
 * assimp-utils/mdbtools are already installed -- and invoked here as a plain child process,
 * matching assimp.ts's pattern exactly.
 *
 * MAGO_TILER_JAR points at the jar; PATH is expected to already resolve `java` (the
 * Dockerfile puts the bundled JRE's bin/ on PATH). Both are configurable via env so local
 * dev/CI (where neither is installed) can run everything else and simply skip the tiling
 * integration test -- see tiles/index.test.ts's isMagoTilerAvailable() gate.
 */
function jarPath(): string {
  return process.env['MAGO_TILER_JAR'] ?? '/opt/mago-3d-tiler.jar';
}

export class MagoTilerUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`mago-3d-tiler is not available: ${String(cause)}`);
    this.name = 'MagoTilerUnavailableError';
  }
}

export async function isMagoTilerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('java', ['-jar', jarPath(), '--help']);
    return true;
  } catch (err) {
    // A non-zero exit from --help still proves java + the jar both launched; only ENOENT
    // (no `java` binary, or the jar path doesn't exist) means the tool truly isn't available.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export interface MagoTilerOptions {
  /** [Tileset] Maximum number of triangles per node -- the main lever for controlling
   * individual tile size. Lower = smaller, more numerous tiles. */
  maxTriangleCount: number;
}

/** Runs `java -jar mago-3d-tiler.jar -input <inputDir> -output <outputDir> -inputType glb
 * -outputType glb -tv 1.1 -mx <maxTriangleCount> -sbn`. mago-3d-tiler takes a *directory* as
 * input (it globs by -inputType inside it), not a single file path -- callers are expected
 * to have already staged the intermediate GLB alone in its own directory. Produces
 * `{outputDir}/tileset.json` plus the tile (.glb) files themselves on success. */
export async function runMagoTiler(inputDir: string, outputDir: string, options: MagoTilerOptions): Promise<void> {
  try {
    await execFileAsync('java', [
      '-jar',
      jarPath(),
      '-input',
      inputDir,
      '-output',
      outputDir,
      '-inputType',
      'glb',
      // -outputType glb: 3D Tiles 1.1 (-tv 1.1) uses native GLB tile content.
      // Do NOT use -outputType b3dm here -- b3dm is the legacy 1.0 format and
      // conflicts with -tv 1.1, causing a crash when combined with -sbn.
      '-outputType',
      'glb',
      '-tv',
      '1.1',
      '-mx',
      String(options.maxTriangleCount),
      // -sbn (splitByNode): tells mago-3d-tiler to treat each node/mesh
      // in the input GLB as a separate splittable unit. Without this flag,
      // a single GLB input is treated as one indivisible tile regardless
      // of its internal node count -- confirmed by testing with 8,511-node
      // input that produced exactly one 46MB tile across the full -mx range.
      '-sbn',
    ]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new MagoTilerUnavailableError(err);
    throw new Error(`mago-3d-tiler ${inputDir} -> ${outputDir} failed: ${String(err)}`);
  }
}
