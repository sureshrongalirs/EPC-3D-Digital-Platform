import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Reads the *built* declaration file (requires `pnpm build` to have run first — true for
// the project's lint -> typecheck -> build -> test CI order) rather than the source, so
// this catches leakage that only shows up after tsc resolves and flattens the public types.
const here = path.dirname(fileURLToPath(import.meta.url));
const dtsPath = path.resolve(here, '..', '..', 'dist', 'index.d.ts');

describe('@plantscope/core public API surface', () => {
  it('never references the underlying rendering engine in dist/index.d.ts', () => {
    const dts = readFileSync(dtsPath, 'utf8');
    expect(dts.toLowerCase()).not.toContain('three');
  });

  it('re-exports Viewer, and only from local modules or @plantscope/shared', () => {
    const dts = readFileSync(dtsPath, 'utf8');
    expect(dts).toContain('export { Viewer }');

    const fromClauses = [...dts.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(fromClauses.length).toBeGreaterThan(0);
    for (const specifier of fromClauses) {
      expect(specifier === '@plantscope/shared' || specifier!.startsWith('.')).toBe(true);
    }
  });
});
