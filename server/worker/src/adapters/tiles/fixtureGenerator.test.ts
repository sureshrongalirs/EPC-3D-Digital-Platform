import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import type { Node as GltfNode } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
// testdata/scripts/generate-plant-grid-fixture.mjs writes synthetic plant-grid GLB(s) used by
// Phase 5R Task 0's mago-3d-tiler re-validation spike, and (generateHierarchyFixture) Task 2's
// per-object splitter test fixture -- generated fresh here (via a dynamic, non-literal import
// specifier so tsc's rootDir check doesn't try to resolve it at compile time) rather than
// committed, since production-scale output is large (CLAUDE.md invariant #8's spirit). This
// test only exercises the generator's own correctness at a small, fast-to-run scale; the
// actual >50MB/5,000+-object spike run is a separate manual invocation documented in
// docs/phase5r/task0-findings.md.
const generatorPath = path.resolve(here, '..', '..', '..', '..', '..', 'testdata', 'scripts', 'generate-plant-grid-fixture.mjs');

interface HierarchyFixtureResult {
  mode: 'hierarchy';
  seed: number;
  buildingCount: number;
  floorsPerBuilding: number;
  roomsPerFloor: number;
  objectsPerRoom: number;
  depth: number;
  totalObjects: number;
  normalObjectCount: number;
  fragmentCount: number;
  normalTriangleCount: number;
  fragmentTriangleCount: number;
  fileCount: number;
  totalBytes: number;
}

interface HierarchyFixtureOptions {
  seed?: number;
  buildingCount?: number;
  floorsPerBuilding?: number;
  roomsPerFloor?: number;
  objectsPerRoom?: number;
  fragmentProbability?: number;
  normalSegments?: number;
  fragmentSegments?: number;
}

async function loadGenerator(): Promise<{
  generatePlantGridFixture: (
    outDir: string,
    mode: 'merged' | 'split',
    objectCount?: number,
    segments?: number,
  ) => Promise<{ mode: string; objectCount: number; fileCount: number; totalBytes: number }>;
  generateHierarchyFixture: (outDir: string, options?: HierarchyFixtureOptions) => Promise<HierarchyFixtureResult>;
}> {
  return (await import(pathToFileURL(generatorPath).href)) as Awaited<ReturnType<typeof loadGenerator>>;
}

/** Depth-first collection of every node in the default scene, each paired with its full
 * hierarchy path (root-to-node names, joined by '/') -- the identity scheme Task 2's splitter
 * is expected to use instead of trusting bare node names (which this fixture deliberately
 * duplicates across parents). */
function collectNodesWithPaths(node: GltfNode, parentPath: string[], out: { node: GltfNode; path: string[] }[]): void {
  const nodePath = [...parentPath, node.getName()];
  out.push({ node, path: nodePath });
  for (const child of node.listChildren()) collectNodesWithPaths(child, nodePath, out);
}

function triangleCountOf(node: GltfNode): number {
  const mesh = node.getMesh();
  if (!mesh) return 0;
  let count = 0;
  for (const primitive of mesh.listPrimitives()) {
    const indices = primitive.getIndices();
    count += (indices ? indices.getCount() : (primitive.getAttribute('POSITION')?.getCount() ?? 0)) / 3;
  }
  return count;
}

describe('generatePlantGridFixture', () => {
  it('merged mode writes a single GLB containing one mesh per object', async () => {
    const { generatePlantGridFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-plant-grid-'));
    try {
      const result = await generatePlantGridFixture(outDir, 'merged', 25, 2);
      expect(result.fileCount).toBe(1);
      expect(result.objectCount).toBe(25);

      const files = await fsp.readdir(outDir);
      expect(files).toEqual(['model.glb']);

      const doc = await new NodeIO().read(path.join(outDir, 'model.glb'));
      expect(doc.getRoot().listMeshes()).toHaveLength(25);
      expect(doc.getRoot().listNodes()).toHaveLength(25);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('split mode writes one GLB per object, each with exactly one mesh', async () => {
    const { generatePlantGridFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-plant-grid-'));
    try {
      const result = await generatePlantGridFixture(outDir, 'split', 25, 2);
      expect(result.fileCount).toBe(25);
      expect(result.objectCount).toBe(25);

      const files = (await fsp.readdir(outDir)).sort();
      expect(files).toHaveLength(25);
      expect(files[0]).toBe('Object_00000.glb');
      expect(files[24]).toBe('Object_00024.glb');

      const doc = await new NodeIO().read(path.join(outDir, files[0]!));
      expect(doc.getRoot().listMeshes()).toHaveLength(1);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('denser objects (more segments) produce more bytes for the same object count', async () => {
    const { generatePlantGridFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-plant-grid-'));
    try {
      const sparse = await generatePlantGridFixture(outDir, 'merged', 10, 1);
      const dense = await generatePlantGridFixture(outDir, 'merged', 10, 6);
      expect(dense.totalBytes).toBeGreaterThan(sparse.totalBytes);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown mode', async () => {
    const { generatePlantGridFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-plant-grid-'));
    try {
      await expect(generatePlantGridFixture(outDir, 'bogus' as 'merged', 5, 1)).rejects.toThrow(/unknown mode/);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });
});

describe('generateHierarchyFixture (Task 2 splitter test fixture)', () => {
  it('produces a hierarchy at least 4 levels deep below the scene root', async () => {
    const { generateHierarchyFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-hierarchy-'));
    try {
      await generateHierarchyFixture(outDir);
      const doc = await new NodeIO().read(path.join(outDir, 'model.glb'));
      const scene = doc.getRoot().getDefaultScene();
      expect(scene).toBeTruthy();

      const nodes: { node: GltfNode; path: string[] }[] = [];
      for (const root of scene!.listChildren()) collectNodesWithPaths(root, [], nodes);

      const maxDepth = Math.max(...nodes.map((n) => n.path.length));
      // Building(1) -> Floor(2) -> Room(3) -> leaf(4): 4 named levels below the scene root.
      expect(maxDepth).toBeGreaterThanOrEqual(4);

      // Every leaf (a node with a mesh) really is at depth 4, not just the deepest node
      // overall -- a fixture with one deep outlier and otherwise-shallow leaves wouldn't be a
      // representative Task 2 test case.
      const leaves = nodes.filter((n) => n.node.getMesh());
      expect(leaves.length).toBeGreaterThan(0);
      for (const leaf of leaves) expect(leaf.path.length).toBe(4);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('reuses the same node names under different parents -- identity must come from the full path, not the name', async () => {
    const { generateHierarchyFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-hierarchy-'));
    try {
      await generateHierarchyFixture(outDir, { buildingCount: 2, floorsPerBuilding: 2, roomsPerFloor: 2, objectsPerRoom: 4 });
      const doc = await new NodeIO().read(path.join(outDir, 'model.glb'));
      const scene = doc.getRoot().getDefaultScene()!;
      const nodes: { node: GltfNode; path: string[] }[] = [];
      for (const root of scene.listChildren()) collectNodesWithPaths(root, [], nodes);

      // "Room_0" appears under every Floor (2 buildings x 2 floors = 4 times), always with a
      // different full path -- duplicate names, unique paths.
      const room0 = nodes.filter((n) => n.node.getName() === 'Room_0');
      expect(room0.length).toBe(4);
      const room0Paths = new Set(room0.map((n) => n.path.join('/')));
      expect(room0Paths.size).toBe(4);

      // Every full leaf path is globally unique even though leaf type names repeat within
      // every room.
      const leafPaths = nodes.filter((n) => n.node.getMesh()).map((n) => n.path.join('/'));
      expect(new Set(leafPaths).size).toBe(leafPaths.length);

      // But the leaf *names* themselves are not unique -- that's the whole point of the fixture.
      const leafNames = nodes.filter((n) => n.node.getMesh()).map((n) => n.node.getName());
      expect(new Set(leafNames).size).toBeLessThan(leafNames.length);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('mixes normal objects and sub-floor fragments, with fragments having far fewer triangles', async () => {
    const { generateHierarchyFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-hierarchy-'));
    try {
      const result = await generateHierarchyFixture(outDir, {
        buildingCount: 2,
        floorsPerBuilding: 2,
        roomsPerFloor: 2,
        objectsPerRoom: 10,
        fragmentProbability: 0.4,
      });
      expect(result.normalObjectCount).toBeGreaterThan(0);
      expect(result.fragmentCount).toBeGreaterThan(0);
      expect(result.normalObjectCount + result.fragmentCount).toBe(result.totalObjects);
      expect(result.fragmentTriangleCount).toBeLessThan(result.normalTriangleCount);

      const doc = await new NodeIO().read(path.join(outDir, 'model.glb'));
      const scene = doc.getRoot().getDefaultScene()!;
      const nodes: { node: GltfNode; path: string[] }[] = [];
      for (const root of scene.listChildren()) collectNodesWithPaths(root, [], nodes);
      const leaves = nodes.filter((n) => n.node.getMesh());

      const fragmentLeaves = leaves.filter((n) => n.node.getName().startsWith('Frag_'));
      const normalLeaves = leaves.filter((n) => !n.node.getName().startsWith('Frag_'));
      expect(fragmentLeaves.length).toBe(result.fragmentCount);
      expect(normalLeaves.length).toBe(result.normalObjectCount);

      // The real signal a splitter must use is triangle count, not the name prefix -- assert
      // every fragment leaf's actual triangle count really is below every normal leaf's.
      const maxFragmentTriangles = Math.max(...fragmentLeaves.map((n) => triangleCountOf(n.node)));
      const minNormalTriangles = Math.min(...normalLeaves.map((n) => triangleCountOf(n.node)));
      expect(maxFragmentTriangles).toBeLessThan(minNormalTriangles);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('is deterministic: the same seed produces byte-identical output across separate runs', async () => {
    const { generateHierarchyFixture } = await loadGenerator();
    const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-hierarchy-'));
    const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-hierarchy-'));
    try {
      await generateHierarchyFixture(dirA, { seed: 7 });
      await generateHierarchyFixture(dirB, { seed: 7 });

      const bytesA = await fsp.readFile(path.join(dirA, 'model.glb'));
      const bytesB = await fsp.readFile(path.join(dirB, 'model.glb'));
      const hashA = crypto.createHash('sha256').update(bytesA).digest('hex');
      const hashB = crypto.createHash('sha256').update(bytesB).digest('hex');
      expect(hashA).toBe(hashB);
    } finally {
      await fsp.rm(dirA, { recursive: true, force: true });
      await fsp.rm(dirB, { recursive: true, force: true });
    }
  });

  it('different seeds actually change the output (the fragment mix depends on the seed, not just the parameters)', async () => {
    const { generateHierarchyFixture } = await loadGenerator();
    const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-hierarchy-'));
    const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-hierarchy-'));
    try {
      await generateHierarchyFixture(dirA, { seed: 1, roomsPerFloor: 4, objectsPerRoom: 12 });
      await generateHierarchyFixture(dirB, { seed: 2, roomsPerFloor: 4, objectsPerRoom: 12 });

      // Byte-hash comparison rather than comparing fragmentCount directly: two different seeds
      // landing on the same *count* of fragments (out of ~192 independent coin flips) isn't
      // astronomically unlikely, but producing byte-identical GLBs by coincidence is -- any
      // single differing per-slot choice changes which triangles get written.
      const hashA = crypto.createHash('sha256').update(await fsp.readFile(path.join(dirA, 'model.glb'))).digest('hex');
      const hashB = crypto.createHash('sha256').update(await fsp.readFile(path.join(dirB, 'model.glb'))).digest('hex');
      expect(hashA).not.toBe(hashB);
    } finally {
      await fsp.rm(dirA, { recursive: true, force: true });
      await fsp.rm(dirB, { recursive: true, force: true });
    }
  });
});
