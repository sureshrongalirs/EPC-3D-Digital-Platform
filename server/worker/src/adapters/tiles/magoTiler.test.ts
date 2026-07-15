import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isMagoTilerAvailable } from './magoTiler.js';

async function withMagoTilerJarEnv(value: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env['MAGO_TILER_JAR'];
  process.env['MAGO_TILER_JAR'] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env['MAGO_TILER_JAR'];
    else process.env['MAGO_TILER_JAR'] = previous;
  }
}

describe('isMagoTilerAvailable', () => {
  it('reports unavailable when MAGO_TILER_JAR points at a directory, not a file (PR #13 fix-up: fs.access alone cannot distinguish these)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-magotiler-jarpath-'));
    const fakeJarDir = path.join(dir, 'not-actually-a-jar');
    await fsp.mkdir(fakeJarDir);

    try {
      await withMagoTilerJarEnv(fakeJarDir, async () => {
        expect(await isMagoTilerAvailable()).toBe(false);
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports unavailable when MAGO_TILER_JAR points at a path that does not exist at all', async () => {
    await withMagoTilerJarEnv('/definitely/does/not/exist/mago-3d-tiler.jar', async () => {
      expect(await isMagoTilerAvailable()).toBe(false);
    });
  });

  // NOT covered here, deliberately: a real, existing, non-directory file that exists but is
  // not a genuinely valid jar (corrupt, wrong format, empty). Confirmed by hitting it directly
  // during this fix-up -- java itself exits non-zero for an invalid jar, indistinguishable at
  // the exit-code level from mago-3d-tiler's own --help parser returning non-zero (the
  // existing, deliberate "non-ENOENT still counts as available" assumption this function
  // already makes for that second case). Fixing that would need parsing java's stderr for a
  // specific "Invalid or corrupt jarfile" message (fragile across JVM versions) or checking
  // the jar's own magic bytes -- out of this fix-up's scope (file-existence/type only, per
  // the reported finding: "a directory or dangling path"), not silently assumed solved here.
});
