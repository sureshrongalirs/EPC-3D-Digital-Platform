import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { loadTileset, repairTileset, validateTileset, writeTileset, type TilesetJson } from './tilesetIntegrity.js';

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-tileset-integrity-'));
}

/** A minimal, real, parseable GLB -- a single triangle offset by `offset`, so bounding-box
 * computation and union across multiple tiles is meaningfully testable. Mirrors the pattern
 * already used by index.test.ts's buildAssimpAuthoredFbx. */
async function writeTestGlb(glbPath: string, offset: [number, number, number] = [0, 0, 0]): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const [ox, oy, oz] = offset;
  const positions = new Float32Array([ox, oy, oz, ox + 2, oy, oz, ox, oy + 2, oz]);
  const indices = new Uint16Array([0, 1, 2]);
  const positionAccessor = doc.createAccessor('positions').setType('VEC3').setArray(positions).setBuffer(buffer);
  const indexAccessor = doc.createAccessor('indices').setType('SCALAR').setArray(indices).setBuffer(buffer);
  const primitive = doc.createPrimitive().setAttribute('POSITION', positionAccessor).setIndices(indexAccessor);
  const mesh = doc.createMesh('Triangle').addPrimitive(primitive);
  const node = doc.createNode('Triangle').setMesh(mesh);
  doc.createScene('Scene').addChild(node);
  await new NodeIO().write(glbPath, doc);
}

describe('loadTileset (case (c): "no tileset.json, or an unparseable one" detection)', () => {
  it('reports "missing" for a completely empty output dir', async () => {
    const dir = await makeTempDir();
    try {
      expect((await loadTileset(dir)).status).toBe('missing');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports "missing" for a dir that has real content files but no tileset.json', async () => {
    const dir = await makeTempDir();
    try {
      await writeTestGlb(path.join(dir, 'R0C0000.glb'));
      await writeTestGlb(path.join(dir, 'R0C0001.glb'));
      expect((await loadTileset(dir)).status).toBe('missing');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports "malformed" for invalid JSON in tileset.json', async () => {
    const dir = await makeTempDir();
    try {
      await fsp.writeFile(path.join(dir, 'tileset.json'), '{ this is not valid JSON');
      const result = await loadTileset(dir);
      expect(result.status).toBe('malformed');
      if (result.status === 'malformed') expect(result.detail.length).toBeGreaterThan(0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports "malformed" for syntactically valid JSON with no root node', async () => {
    const dir = await makeTempDir();
    try {
      await fsp.writeFile(path.join(dir, 'tileset.json'), JSON.stringify({ asset: { version: '1.1' } }));
      expect((await loadTileset(dir)).status).toBe('malformed');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports "ok" for a well-formed tileset.json with a root node', async () => {
    const dir = await makeTempDir();
    try {
      await writeTileset(dir, { root: { content: { uri: 'tile.glb' } } });
      expect((await loadTileset(dir)).status).toBe('ok');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('validateTileset (Task 1 item 1: content + orphan + stats validation)', () => {
  it('is ok, with correct stats, when every referenced tile exists and is non-empty', async () => {
    const dir = await makeTempDir();
    try {
      await writeTestGlb(path.join(dir, 'a.glb'));
      await writeTestGlb(path.join(dir, 'b.glb'), [10, 0, 0]);
      const tileset: TilesetJson = { root: { content: { uri: 'a.glb' }, children: [{ content: { uri: 'b.glb' } }] } };
      await writeTileset(dir, tileset);

      const result = await validateTileset(dir);
      expect(result.ok).toBe(true);
      expect(result.loadStatus).toBe('ok');
      expect(result.missing).toEqual([]);
      expect(result.orphans).toEqual([]);
      expect(result.tileCount).toBe(2);
      expect(result.tiles.map((t) => t.uri).sort()).toEqual(['a.glb', 'b.glb']);
      expect(result.totalBytes).toBeGreaterThan(0);
      expect(result.maxTileBytes).toBeGreaterThan(0);
      expect(result.maxTileBytes).toBeLessThanOrEqual(result.totalBytes);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a referenced-but-absent tile as missing and fails ok', async () => {
    const dir = await makeTempDir();
    try {
      await writeTileset(dir, { root: { content: { uri: 'does-not-exist.glb' } } });
      const result = await validateTileset(dir);
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(['does-not-exist.glb']);
      expect(result.tileCount).toBe(0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a referenced-but-zero-byte tile as missing (not a usable tile)', async () => {
    const dir = await makeTempDir();
    try {
      await fsp.writeFile(path.join(dir, 'empty.glb'), Buffer.alloc(0));
      await writeTileset(dir, { root: { content: { uri: 'empty.glb' } } });
      const result = await validateTileset(dir);
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(['empty.glb']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an on-disk tile file the tree never references as an orphan, without failing ok', async () => {
    const dir = await makeTempDir();
    try {
      await writeTestGlb(path.join(dir, 'referenced.glb'));
      await writeTestGlb(path.join(dir, 'orphan.glb'), [5, 5, 5]);
      await writeTileset(dir, { root: { content: { uri: 'referenced.glb' } } });

      const result = await validateTileset(dir);
      expect(result.ok).toBe(true);
      expect(result.orphans).toEqual(['orphan.glb']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('propagates loadStatus "missing"/"malformed" through to the validation result', async () => {
    const dir = await makeTempDir();
    try {
      const missing = await validateTileset(dir);
      expect(missing.loadStatus).toBe('missing');
      expect(missing.ok).toBe(false);

      await fsp.writeFile(path.join(dir, 'tileset.json'), 'not json');
      const malformed = await validateTileset(dir);
      expect(malformed.loadStatus).toBe('malformed');
      expect(malformed.ok).toBe(false);
      expect(malformed.loadDetail?.length).toBeGreaterThan(0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  // Verbatim tileset.json written by real mago-3d-tiler v1.15.4 (confirmed via direct `java
  // -jar mago-3d-tiler.jar` invocation against an unmaterialed-primitive GLB during PR #11
  // verification) -- a fully well-formed root+children+geometricError chain, REPLACE refine,
  // the 3DTILES_content_gltf extension declared, and ZERO `content`/`contents` keys anywhere
  // in the tree. This is not "references content that's missing" (case (b)'s repair target)
  // -- nothing is referenced at all, so there's nothing to repair from. Before this fix,
  // `ok` was `missing.length === 0`, which is vacuously true here, so this tileset published
  // successfully with zero renderable tiles.
  const REAL_MAGO_ZERO_CONTENT_TILESET =
    '{"asset":{"version":"1.1"},"geometricError":16.0,"root":{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":16.0,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":256.1,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":128.1,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":64.1,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":32.1,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":16.1,"children":[{"boundingVolume":{"region":[0.0,-1.0E-8,1.5E-7,1.5E-7,3.0E-8,3.0E-8]},"refine":"REPLACE","geometricError":8.1}]}]}]}]}]}]},"extensionsUsed":["3DTILES_content_gltf"],"extensions":{"3DTILES_content_gltf":{}}}';

  it('fails ok (and reports referencedCount === 0) for the exact real-mago zero-content shape, even though nothing is technically "missing"', async () => {
    const dir = await makeTempDir();
    try {
      await fsp.writeFile(path.join(dir, 'tileset.json'), REAL_MAGO_ZERO_CONTENT_TILESET);

      const result = await validateTileset(dir);
      expect(result.loadStatus).toBe('ok');
      expect(result.missing).toEqual([]);
      expect(result.referencedCount).toBe(0);
      expect(result.tileCount).toBe(0);
      expect(result.ok).toBe(false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('regression guard: a valid tileset with exactly one surviving tile is still ok (only tileCount === 0 is disqualifying)', async () => {
    const dir = await makeTempDir();
    try {
      await writeTestGlb(path.join(dir, 'only.glb'));
      await writeTileset(dir, { root: { content: { uri: 'only.glb' } } });

      const result = await validateTileset(dir);
      expect(result.ok).toBe(true);
      expect(result.referencedCount).toBe(1);
      expect(result.tileCount).toBe(1);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('repairTileset (Task 1 item 2: regenerate from surviving content only)', () => {
  it('regenerates a tileset referencing only surviving content, with a bounding volume computed from real GLB geometry, and re-validates clean', async () => {
    const dir = await makeTempDir();
    try {
      await writeTestGlb(path.join(dir, 'good-a.glb'), [0, 0, 0]);
      await writeTestGlb(path.join(dir, 'good-b.glb'), [100, 0, 0]);
      // tileset.json references 3 tiles, but only 2 exist -- the real-world failure mode
      // from prior client-file testing ("tileset.json referencing 5 LOD content files but
      // produced only 1 on disk").
      await writeTileset(dir, {
        root: {
          content: { uri: 'missing.glb' },
          children: [{ content: { uri: 'good-a.glb' } }, { content: { uri: 'good-b.glb' } }],
        },
      });

      const before = await validateTileset(dir);
      expect(before.ok).toBe(false);

      const repairResult = await repairTileset(dir);
      expect(repairResult.kept.sort()).toEqual(['good-a.glb', 'good-b.glb']);
      expect(repairResult.dropped).toEqual(['missing.glb']);

      const after = await validateTileset(dir);
      expect(after.ok).toBe(true);
      expect(after.loadStatus).toBe('ok');
      expect(after.tileCount).toBe(2);

      const raw = await fsp.readFile(path.join(dir, 'tileset.json'), 'utf-8');
      const tileset = JSON.parse(raw) as TilesetJson;
      expect(tileset.root.children).toHaveLength(2);
      expect(tileset.root.content).toBeUndefined();
      expect(tileset.root.refine).toBe('ADD');

      // Root's regenerated bounding box must actually span both surviving tiles (0..2 and
      // 100..102 on X), not a stale box sized for the 3-tile scheme that no longer exists.
      const rootBox = tileset.root.boundingVolume?.box;
      expect(rootBox).toBeDefined();
      const cx = rootBox![0]!;
      const hx = rootBox![3]!;
      expect(cx - hx).toBeLessThanOrEqual(0.5);
      expect(cx + hx).toBeGreaterThanOrEqual(101.5);

      // Every child has its own non-degenerate bounding volume and zero geometricError (it's
      // the finest available detail for its content).
      for (const child of tileset.root.children!) {
        expect(child.geometricError).toBe(0);
        expect(child.boundingVolume?.box).toBeDefined();
        expect(child.content?.uri).toMatch(/^good-/);
      }

      // Root's geometricError must be positive so clients actually refine past it.
      expect(tileset.root.geometricError).toBeGreaterThan(0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws (never invoked for case (c)) when there is no valid tileset.json to repair', async () => {
    const dir = await makeTempDir();
    try {
      await expect(repairTileset(dir)).rejects.toThrow(/nothing to repair/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when every referenced tile is missing -- nothing survives to rebuild from', async () => {
    const dir = await makeTempDir();
    try {
      await writeTileset(dir, { root: { content: { uri: 'gone.glb' } } });
      await expect(repairTileset(dir)).rejects.toThrow(/nothing survives/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
