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
 * -outputType b3dm -tv 1.1 -mx <maxTriangleCount> -nl 3 -xl 8 -mg 100`. mago-3d-tiler takes a
 * *directory* as input (it globs by -inputType inside it), not a single file path -- callers
 * are expected to have already staged the intermediate GLB alone in its own directory.
 * Produces `{outputDir}/tileset.json` plus the tile files themselves on success -- see
 * TILE_CONTENT_EXTENSIONS in ../tiles/index.ts for why those are actually named .glb despite
 * -outputType being 'b3dm' (confirmed against a real run). */
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
      // -outputType: only b3dm/i3dm/pnts are valid values (confirmed directly against
      // `java -jar mago-3d-tiler.jar --help` on the real v1.15.4 binary -- 'glb' and
      // '3dtiles' are NOT accepted here despite seeming like the obvious choice given -tv
      // 1.1's actual tile output; passing an unrecognized value here is what previously
      // crashed mago-3d-tiler with "Tileset root node children is null or empty" when
      // combined with -sbn, not a real b3dm/-tv-1.1 conflict as first suspected. b3dm
      // ("Batched 3D Model") is the correct semantic category for a single textured mesh
      // batch -- i3dm is for GPU-instanced models, pnts is for point clouds.
      '-outputType',
      'b3dm',
      '-tv',
      '1.1',
      '-mx',
      String(options.maxTriangleCount),
      // -sbn was tested and removed -- it crashes with "Total Node Count 0"
      // on real GLB input (confirmed upstream bug, mago-3d-tiler issue #52).
      //
      // -nl/-xl/-mg: the LOD-depth levers that actually control real tile subdivision,
      // separate from -mx (the per-tile triangle budget). Real testing showed -mx alone,
      // across its full practical range (30,000 down to 500), had no effect on tile count
      // or size for an 8,511-node input -- one 46MB tile every time -- so -mx alone isn't
      // sufficient; mago-3d-tiler also needs to be told how many LOD levels to actually
      // generate.
      //   -nl (--minLod): minimum level of detail to generate.
      //   -xl (--maxLod): maximum level of detail to generate -- more levels means more
      //     opportunities to subdivide.
      //   -mg (--maxGeometricError): NOT "merge distance in meters" despite how it may read --
      //     confirmed directly against --help ("[Tileset] Maximum geometric error"). It's a
      //     3D Tiles screen-space-error-style tolerance: the largest geometric error a tile
      //     is allowed to have before a finer LOD is required, so a smaller value forces more
      //     aggressive subdivision to stay under it.
      '-nl',
      '3',
      '-xl',
      '8',
      '-mg',
      '100',
    ]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new MagoTilerUnavailableError(err);
    throw new Error(`mago-3d-tiler ${inputDir} -> ${outputDir} failed: ${String(err)}`);
  }
}
