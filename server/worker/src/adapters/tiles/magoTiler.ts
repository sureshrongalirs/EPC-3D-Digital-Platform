import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
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
  // Checked separately from the java invocation below, and BEFORE it: contrary to this
  // function's own previous doc comment, `execFile('java', ['-jar', jarPath(), ...])` does
  // NOT surface a missing jar as ENOENT -- ENOENT only ever means "the `java` executable
  // itself could not be spawned." If `java` is on PATH but jarPath() doesn't exist (e.g. a
  // dev machine with some other JDK installed, no real mago-3d-tiler jar anywhere), java
  // starts fine and exits non-zero with its own "Error: Unable to access jarfile" message --
  // a NUMERIC exit code, which the old `!== 'ENOENT'` check let through as "available"
  // (confirmed as a real, reachable bug via normalHandling.wsl.test.ts, the first test in
  // this repo to gate on mago-3d-tiler availability without ALSO being gated by assimp
  // unavailability masking it on non-WSL machines). Checking the jar's own existence directly
  // is unambiguous and doesn't depend on interpreting java's process-exit semantics at all.
  try {
    await fsp.access(jarPath());
  } catch {
    return false;
  }

  try {
    await execFileAsync('java', ['-jar', jarPath(), '--help']);
    return true;
  } catch (err) {
    // A non-zero exit from --help (mago-3d-tiler's own CLI parser returning non-zero for
    // `--help`, for instance) still proves java could launch the jar -- only ENOENT (no
    // `java` binary at all) means the tool truly isn't available at this point, since the
    // jar's existence was already confirmed above.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export interface MagoTilerOptions {
  /** [Tileset] Maximum number of triangles per node -- the main lever for controlling
   * individual tile size. Lower = smaller, more numerous tiles. */
  maxTriangleCount: number;
}

export interface MagoTilerResult {
  /** Process exit code. 0 on a normal run. Non-zero means mago-3d-tiler itself reported
   * failure (e.g. the Task 0 spike's `TileProcessingException: Tileset root node children is
   * null or empty` crash on dense merged-GLB input) -- the integrity gate in ./index.ts must
   * treat this as an immediate hard failure without even looking at the output directory, since
   * a non-zero exit means mago itself gave up, not that it produced something merely
   * incomplete. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `java -jar mago-3d-tiler.jar -input <inputDir> -output <outputDir> -inputType glb
 * -outputType b3dm -tv 1.1 -mx <maxTriangleCount>`. mago-3d-tiler takes a *directory* as input
 * (it globs by -inputType inside it), not a single file path -- callers are expected to have
 * already staged the input as a directory of per-object GLBs (Task 2's splitter.ts; a single
 * merged GLB never subdivides at all regardless of flags, see below). Produces
 * `{outputDir}/tileset.json` plus the tile files themselves on success -- see
 * TILE_CONTENT_EXTENSIONS in ../tiles/index.ts for why those are actually named .glb despite
 * -outputType being 'b3dm' (confirmed against a real run).
 *
 * Deliberately does not throw on a non-zero mago exit (only on ENOENT -- java/the jar itself
 * missing) -- it returns the exit code plus captured stdout/stderr instead, so the caller's
 * integrity gate can build a structured, user-visible failure message (exit code + last log
 * lines) rather than swallowing that detail into a generic execFile error. */
export async function runMagoTiler(inputDir: string, outputDir: string, options: MagoTilerOptions): Promise<MagoTilerResult> {
  try {
    const { stdout, stderr } = await execFileAsync('java', [
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
      // -nl/-xl/-mg (--minLod/--maxLod/--maxGeometricError, the LOD-depth levers) were added
      // in an earlier revision of this file, on the belief -- based on real testing at the
      // time -- that they were necessary for real tile subdivision, since -mx alone had no
      // effect across its full practical range on an 8,511-node MERGED-GLB input (one 46MB
      // tile every time, regardless of -mx). REMOVED here, corrected by Phase 5R Task 0/2:
      // that observation was real, but the conclusion was wrong. mago-3d-tiler fundamentally
      // does not spatially subdivide a single merged-GLB input at all, no matter what flags
      // are passed -- confirmed directly (docs/phase5r/task0-findings.md): merged-mode input
      // produces either a fixed, fake 4-tile templated LOD chain (regardless of real object
      // count or size) or, above a density threshold, crashes outright with zero output. What
      // -nl/-xl/-mg actually appeared to change was which flavor of that non-representative
      // merged-mode behavior showed up, not real subdivision. A DIRECTORY of separate
      // per-object GLBs (this worker's own splitter.ts, Task 2) is what mago actually
      // subdivides for real, and Task 0's directory-mode validation run -- 142 real,
      // spatially-subdivided, budget-compliant tiles, max 4.1MB, zero missing references --
      // used -tv 1.1 -mx <N> ALONE, with no -nl/-xl/-mg, and needed nothing else. Re-confirmed
      // directly against production worker code (not a standalone spike script) during Task 2:
      // see the Task 2 PR description for the with-vs-without A/B comparison run.
    ]);
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const execErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (execErr.code === 'ENOENT') throw new MagoTilerUnavailableError(err);
    // execFile sets `.code` to the process's numeric exit code on a normal non-zero exit, or
    // to a string (e.g. 'ENOENT', handled above) when the process never ran at all. A signal
    // kill leaves `.code` null/undefined -- reported as -1 since there is no real exit code.
    const exitCode = typeof execErr.code === 'number' ? execErr.code : -1;
    return { exitCode, stdout: execErr.stdout ?? '', stderr: execErr.stderr ?? '' };
  }
}
