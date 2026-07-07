import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Hard rule for this whole package (see CLAUDE.md invariant #1): nothing in
// @plantscope/plugins may import three.js. Plugins only ever touch the CoreSDK facade
// and PluginContext exported by @plantscope/core. This reads the *built* output (requires
// `pnpm build` to have run first — true for this repo's lint -> typecheck -> build -> test
// CI order), not the source, so it also catches leakage introduced by bundling/resolution.
const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');

function listFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listFilesRecursive(full));
    } else if (
      (full.endsWith('.js') || full.endsWith('.d.ts')) &&
      !full.includes('.test.')
    ) {
      // Test files aren't part of the shipped plugin output consumers import — only
      // scan the actual source (also sidesteps this test's own description text
      // containing the literal string this check greps for).
      files.push(full);
    }
  }
  return files;
}

describe('@plantscope/plugins isolation from three.js', () => {
  it('no built file imports from "three"', () => {
    const files = listFilesRecursive(distDir);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (/from\s+['"]three(\/[^'"]*)?['"]/.test(content)) {
        offenders.push(path.relative(distDir, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
