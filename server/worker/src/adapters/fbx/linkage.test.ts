import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseFBXLinkages } from './linkage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, '..', '..', '..', '..', '..', 'testdata', 'fixtures', 'linkage-fixture.fbx');

describe('parseFBXLinkages (synthetic linkage-fixture.fbx, FBX version 7500)', () => {
  it('recovers the Linkages property from every Model that has one, keyed by node name', () => {
    const buf = readFileSync(fixturePath);
    const map = parseFBXLinkages(buf);

    expect(map).toEqual(
      new Map([
        ['Pump-1', 'LINK-1001'],
        ['Valve-1', 'LINK-1002'],
      ]),
    );
  });

  it('skips Model nodes with no Properties70 block (Tank-1) without erroring', () => {
    const buf = readFileSync(fixturePath);
    const map = parseFBXLinkages(buf);
    expect(map.has('Tank-1')).toBe(false);
  });

  it('correctly walks past an unrelated zlib-compressed float64 array (Geometry/Vertices) that precedes Objects', () => {
    // If the compressed-array property weren't decoded/skipped correctly, the cursor would
    // desync and either throw or silently produce garbage node names for Objects/Model --
    // this is exercised implicitly by the exact map above, asserted again here for clarity.
    const buf = readFileSync(fixturePath);
    expect(() => parseFBXLinkages(buf)).not.toThrow();
  });
});
