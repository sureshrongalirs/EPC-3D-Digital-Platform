import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Document, NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { splitObjects } from './splitter.js';
import { normalMatrixFrom, normalize3, transformDirection, transformPoint, type Vec3 } from './worldTransform.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const generatorPath = path.resolve(here, '..', '..', '..', '..', '..', 'testdata', 'scripts', 'generate-plant-grid-fixture.mjs');

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
  generatePlantGridFixture: (outDir: string, mode: 'merged' | 'split', objectCount?: number, segments?: number) => Promise<unknown>;
  generateHierarchyFixture: (outDir: string, options?: HierarchyFixtureOptions) => Promise<{ totalObjects: number; normalObjectCount: number; fragmentCount: number }>;
}> {
  return (await import(pathToFileURL(generatorPath).href)) as Awaited<ReturnType<typeof loadGenerator>>;
}

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-splitter-'));
}

function box(hx: number, hy: number, hz: number): { positions: Float32Array; indices: Uint16Array } {
  // A single triangle is enough for triangle-count purposes; keep it trivial and cheap.
  return {
    positions: new Float32Array([-hx, -hy, -hz, hx, -hy, -hz, 0, hy, hz]),
    indices: new Uint16Array([0, 1, 2]),
  };
}

async function readMetadata(outDir: string): Promise<{ version: number; objects: { file: string; path: string[]; name: string; kind: string; linkageKey?: string; triangleCount: number; mergedFrom?: { name: string; linkageKey?: string }[] }[] }> {
  const raw = await fsp.readFile(path.join(outDir, 'metadata.json'), 'utf-8');
  return JSON.parse(raw) as Awaited<ReturnType<typeof readMetadata>>;
}

async function listGlbFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir);
  return entries.filter((f) => f.endsWith('.glb')).sort();
}

describe('splitObjects (Task 2 per-object pipeline reshape)', () => {
  it('flat tree, all normal objects: one file per object, bare-name-degraded identity, no fragments', async () => {
    const { generatePlantGridFixture } = await loadGenerator();
    const genDir = await makeTempDir();
    const outDir = await makeTempDir();
    try {
      await generatePlantGridFixture(genDir, 'merged', 10, 3);
      const result = await splitObjects(path.join(genDir, 'model.glb'), outDir, new Map(), { triangleFloor: 50 });

      expect(result.objects).toHaveLength(10);
      expect(result.objects.every((o) => o.kind === 'normal')).toBe(true);
      expect(result.objects.every((o) => o.mergedFrom === undefined)).toBe(true);
      // Flat tree -> single-segment path -> bare-name filename, no separator.
      expect(result.objects.every((o) => o.path.length === 1)).toBe(true);
      expect(result.objects[0]!.file).toBe(`${result.objects[0]!.name}.glb`);

      const files = await listGlbFiles(outDir);
      expect(files).toHaveLength(10);

      const metadata = await readMetadata(outDir);
      expect(metadata.version).toBe(1);
      expect(metadata.objects).toHaveLength(10);
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('flat tree, one sub-floor leaf directly under the scene root: survives standalone, own file, own metadata record -- never merged, never dropped', async () => {
    const outDir = await makeTempDir();
    const genDir = await makeTempDir();
    try {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const material = doc.createMaterial('Mat').setBaseColorFactor([0.7, 0.7, 0.7, 1]);
      const scene = doc.createScene('Scene');
      doc.getRoot().setDefaultScene(scene);

      function addLeaf(name: string, triangleCount: number): void {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let i = 0; i < triangleCount; i++) {
          const base = positions.length / 3;
          positions.push(0, 0, i, 1, 0, i, 0, 1, i);
          indices.push(base, base + 1, base + 2);
        }
        const pos = doc.createAccessor(`${name}-pos`).setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
        const idx = doc.createAccessor(`${name}-idx`).setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
        const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(material);
        const mesh = doc.createMesh(name).addPrimitive(prim);
        const node = doc.createNode(name).setMesh(mesh);
        scene.addChild(node);
      }

      addLeaf('BigTank', 100); // well above a floor of 50
      addLeaf('TinyBolt', 1); // well below -- and its only ancestor is the scene root itself

      const glbPath = path.join(genDir, 'model.glb');
      await new NodeIO().write(glbPath, doc);

      const result = await splitObjects(glbPath, outDir, new Map(), { triangleFloor: 50 });

      expect(result.objects).toHaveLength(2);
      const bigTank = result.objects.find((o) => o.name === 'BigTank');
      const tinyBolt = result.objects.find((o) => o.name === 'TinyBolt');
      expect(bigTank?.kind).toBe('normal');
      expect(tinyBolt?.kind).toBe('standaloneFragment');
      expect(tinyBolt?.mergedFrom).toBeUndefined();
      expect(bigTank?.mergedFrom).toBeUndefined(); // TinyBolt must NOT have been merged into it

      const files = await listGlbFiles(outDir);
      expect(files).toHaveLength(2); // TinyBolt has its own file -- never dropped, never merged
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('assimp\'s synthetic "RootNode" wrapper (real client-file shape) is stripped: flat objects underneath it are treated exactly as if they were direct scene children -- bare-name identity, and a sub-floor leaf stays standalone rather than merging into the wrapper', async () => {
    // Reproduces testdata/local/2 1.fbx's real exported shape exactly: scene.listChildren()
    // is a single meshless node literally named "RootNode", with every real object as ITS
    // child, never the scene's -- confirmed via this task's own end-to-end run against that
    // file (docs/phase5r/task2-findings.md). Left unhandled, every object's path/filename
    // gets a spurious "RootNode__" prefix (violating the flat-tree bare-name-degradation rule)
    // and TinyBolt-style root-level fragments merge into one oversized "RootNode" blob instead
    // of staying standalone (docs/phase5r/task2-kickoff-amendment.md item 2).
    const outDir = await makeTempDir();
    const genDir = await makeTempDir();
    try {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const material = doc.createMaterial('Mat').setBaseColorFactor([0.7, 0.7, 0.7, 1]);
      const scene = doc.createScene('Scene');
      doc.getRoot().setDefaultScene(scene);

      function addLeaf(parent: ReturnType<Document['createNode']>, name: string, triangleCount: number): void {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let i = 0; i < triangleCount; i++) {
          const base = positions.length / 3;
          positions.push(0, 0, i, 1, 0, i, 0, 1, i);
          indices.push(base, base + 1, base + 2);
        }
        const pos = doc.createAccessor(`${name}-pos`).setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
        const idx = doc.createAccessor(`${name}-idx`).setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
        const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(material);
        const mesh = doc.createMesh(name).addPrimitive(prim);
        const node = doc.createNode(name).setMesh(mesh);
        parent.addChild(node);
      }

      const rootNode = doc.createNode('RootNode'); // meshless, sole scene child -- the assimp wrapper
      scene.addChild(rootNode);
      addLeaf(rootNode, 'Object_6', 100); // well above a floor of 50
      addLeaf(rootNode, 'Object_9', 1); // well below -- only ancestor besides the wrapper is the scene root

      const glbPath = path.join(genDir, 'model.glb');
      await new NodeIO().write(glbPath, doc);

      const result = await splitObjects(glbPath, outDir, new Map(), { triangleFloor: 50 });

      expect(result.objects).toHaveLength(2);
      const normalObj = result.objects.find((o) => o.name === 'Object_6');
      const fragmentObj = result.objects.find((o) => o.name === 'Object_9');

      expect(normalObj?.kind).toBe('normal');
      expect(normalObj?.path).toEqual(['Object_6']); // no "RootNode" segment
      expect(normalObj?.file).toBe('Object_6.glb');

      expect(fragmentObj?.kind).toBe('standaloneFragment'); // not merged into the RootNode wrapper
      expect(fragmentObj?.path).toEqual(['Object_9']);
      expect(fragmentObj?.file).toBe('Object_9.glb');
      expect(normalObj?.mergedFrom).toBeUndefined();

      const files = await listGlbFiles(outDir);
      expect(files.sort()).toEqual(['Object_6.glb', 'Object_9.glb']);
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('a meshless single top-level node that is NOT named "RootNode" (e.g. a real single-building site) is kept as a real grouping ancestor, not stripped -- and gets the informational (not stripped) warning, since resolveEffectiveRoots() cannot itself tell this apart from a renamed wrapper', async () => {
    // Guards the narrow scope of the RootNode-stripping fix above: a legitimate single-
    // building site is also "one meshless node, sole scene child" but must still be a valid
    // fragment-merge target, unlike assimp's synthetic wrapper.
    const { generateHierarchyFixture } = await loadGenerator();
    const genDir = await makeTempDir();
    const outDir = await makeTempDir();
    try {
      await generateHierarchyFixture(genDir, { buildingCount: 1, floorsPerBuilding: 1, roomsPerFloor: 1, objectsPerRoom: 6, fragmentProbability: 1 });
      const result = await splitObjects(path.join(genDir, 'model.glb'), outDir, new Map(), { triangleFloor: 50 });

      expect(result.objects).toHaveLength(1);
      expect(result.objects[0]!.kind).toBe('mergedFragmentGroup');
      expect(result.objects[0]!.path).toEqual(['Building_0', 'Floor_0', 'Room_0']);

      // PR #13 fix-up: the "not stripped" informational warning must fire here -- this shape
      // (sole meshless top-level child, not named "RootNode") is indistinguishable from a
      // renamed/different wrapper purely by structure, so resolveEffectiveRoots() always warns
      // on it. This is expected and correct, not a false positive to suppress.
      const notStrippedWarning = result.warnings.find((w) => w.includes('is meshless but not named "RootNode"'));
      expect(notStrippedWarning).toBeDefined();
      expect(notStrippedWarning).toContain('Building_0');
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('blob-ratio symptom guard: a differently-named wrapper (heuristic bypassed) that welds most of the model into one merged group still gets caught, independent of resolveEffectiveRoots() recognizing the cause', async () => {
    // Reconstructs the RootNode-wrapper bug's SHAPE (most fragments funneled into one output
    // object because their real parent wrapper wasn't recognized/stripped) but under a wrapper
    // named "SceneRoot" instead of "RootNode" -- resolveEffectiveRoots() will NOT strip this
    // (by design, see its own doc comment), so this exercises the second, cause-agnostic line
    // of defense: the blob-ratio guard must fire regardless of why the objects ended up
    // funneled into one file, not only for the one specific cause this task's fix addresses.
    const outDir = await makeTempDir();
    const genDir = await makeTempDir();
    try {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const material = doc.createMaterial('Mat').setBaseColorFactor([0.7, 0.7, 0.7, 1]);
      const scene = doc.createScene('Scene');
      doc.getRoot().setDefaultScene(scene);

      function addLeaf(parent: ReturnType<Document['createNode']>, name: string, triangleCount: number): void {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let i = 0; i < triangleCount; i++) {
          const base = positions.length / 3;
          positions.push(0, 0, i, 1, 0, i, 0, 1, i);
          indices.push(base, base + 1, base + 2);
        }
        const pos = doc.createAccessor(`${name}-pos`).setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
        const idx = doc.createAccessor(`${name}-idx`).setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
        const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(material);
        const mesh = doc.createMesh(name).addPrimitive(prim);
        const node = doc.createNode(name).setMesh(mesh);
        parent.addChild(node);
      }

      const wrapper = doc.createNode('SceneRoot'); // meshless, sole scene child -- NOT "RootNode"
      scene.addChild(wrapper);
      for (let i = 0; i < 10; i++) addLeaf(wrapper, `Frag_${i}`, 1); // 10 fragments, well below the floor
      addLeaf(wrapper, 'BigTank', 100); // 2 normal objects, well above the floor
      addLeaf(wrapper, 'BigValve', 100);

      const glbPath = path.join(genDir, 'model.glb');
      await new NodeIO().write(glbPath, doc);

      const result = await splitObjects(glbPath, outDir, new Map(), { triangleFloor: 50 });

      // Sanity: the heuristic really didn't strip "SceneRoot" -- confirms this test actually
      // reconstructs the bypassed-heuristic shape rather than accidentally not exercising it.
      expect(result.objects.some((o) => o.path[0] === 'SceneRoot')).toBe(true);

      const group = result.objects.find((o) => o.kind === 'mergedFragmentGroup');
      expect(group).toBeDefined();
      expect(group!.mergedFrom).toHaveLength(10); // all 10 fragments welded into one file

      // totalMeshObjects = 10 fragments + 2 normals = 12; the group's 10 constituents is
      // 83.3%, over the default 50% blobWarnRatio threshold.
      const blobWarning = result.warnings.find((w) => w.includes('combines') && w.includes('total mesh-bearing source object'));
      expect(blobWarning).toBeDefined();
      expect(blobWarning).toContain('10 of 12');
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('blob-ratio symptom guard: minimal boundary case (3 of 5 = 60%, just over the default 50% threshold) fires the warning but still publishes normally, does not throw', async () => {
    // Smallest legitimate case that crosses the default 0.5 ratio: one mergedFragmentGroup
    // absorbing 3 of 5 total mesh-bearing objects (60% > 50%). Multi-root scene
    // (Group + BigA + BigB are all direct scene children), so resolveEffectiveRoots() never
    // fires its own "not stripped" warning here -- this test isolates the blob-ratio guard
    // specifically, not the two observability layers interacting.
    const outDir = await makeTempDir();
    const genDir = await makeTempDir();
    try {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const material = doc.createMaterial('Mat').setBaseColorFactor([0.7, 0.7, 0.7, 1]);
      const scene = doc.createScene('Scene');
      doc.getRoot().setDefaultScene(scene);

      function addLeaf(parent: ReturnType<Document['createNode']>, name: string, triangleCount: number): void {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let i = 0; i < triangleCount; i++) {
          const base = positions.length / 3;
          positions.push(0, 0, i, 1, 0, i, 0, 1, i);
          indices.push(base, base + 1, base + 2);
        }
        const pos = doc.createAccessor(`${name}-pos`).setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
        const idx = doc.createAccessor(`${name}-idx`).setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
        const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(material);
        const mesh = doc.createMesh(name).addPrimitive(prim);
        const node = doc.createNode(name).setMesh(mesh);
        parent.addChild(node);
      }

      const group = doc.createNode('Group'); // meshless -- NOT the sole scene child, so no "not stripped" warning
      scene.addChild(group);
      addLeaf(group, 'F1', 1);
      addLeaf(group, 'F2', 1);
      addLeaf(group, 'F3', 1);

      function makeNormalMeshNode(name: string): void {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let i = 0; i < 100; i++) {
          const base = positions.length / 3;
          positions.push(0, 0, i, 1, 0, i, 0, 1, i);
          indices.push(base, base + 1, base + 2);
        }
        const pos = doc.createAccessor(`${name}-pos`).setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
        const idx = doc.createAccessor(`${name}-idx`).setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
        const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(material);
        const mesh = doc.createMesh(name).addPrimitive(prim);
        const node = doc.createNode(name).setMesh(mesh);
        scene.addChild(node);
      }
      makeNormalMeshNode('BigA'); // 100 triangles, well above the floor of 50
      makeNormalMeshNode('BigB');

      const glbPath = path.join(genDir, 'model.glb');
      await new NodeIO().write(glbPath, doc);

      // Total mesh objects = F1 + F2 + F3 + BigA + BigB = 5. The group's 3 constituents is
      // exactly 60% -- just over the default 50% threshold, the smallest legitimate case that
      // still fires (3 of 5; 2 of 5 = 40% would not).
      const result = await splitObjects(glbPath, outDir, new Map(), { triangleFloor: 50 });

      expect(result.objects).toHaveLength(3); // Group's merged object + BigA + BigB, fully populated
      const groupObject = result.objects.find((o) => o.kind === 'mergedFragmentGroup');
      expect(groupObject).toBeDefined();
      expect(groupObject!.mergedFrom).toHaveLength(3);

      const blobWarning = result.warnings.find((w) => w.includes('combines') && w.includes('total mesh-bearing source object'));
      expect(blobWarning).toBeDefined();
      expect(blobWarning).toContain('3 of 5');

      const files = await listGlbFiles(outDir);
      expect(files).toHaveLength(3); // publish proceeded normally -- splitObjects() did not throw
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('nested tree with duplicate names + mixed fragments: fragments group per meshless-ancestor, files = normal + distinct group targets (not normal + fragmentCount)', async () => {
    const { generateHierarchyFixture } = await loadGenerator();
    const genDir = await makeTempDir();
    const outDir = await makeTempDir();
    try {
      const fixtureResult = await generateHierarchyFixture(genDir, {
        buildingCount: 2,
        floorsPerBuilding: 2,
        roomsPerFloor: 2,
        objectsPerRoom: 10,
        fragmentProbability: 0.4,
      });

      // normalSegments=4 -> 192 triangles, fragmentSegments=1 -> 12 triangles (generator
      // defaults) -- a floor of 50 unambiguously separates them.
      const result = await splitObjects(path.join(genDir, 'model.glb'), outDir, new Map(), { triangleFloor: 50 });

      const normalCount = result.objects.filter((o) => o.kind === 'normal').length;
      const groupCount = result.objects.filter((o) => o.kind === 'mergedFragmentGroup').length;
      const standaloneCount = result.objects.filter((o) => o.kind === 'standaloneFragment').length;

      expect(normalCount).toBe(fixtureResult.normalObjectCount);
      expect(standaloneCount).toBe(0); // every fragment here has Room_N as a real named ancestor
      expect(groupCount).toBeGreaterThan(0);
      expect(groupCount).toBeLessThanOrEqual(fixtureResult.fragmentCount);

      // Every fragment must be accounted for exactly once, across all group mergedFrom[].
      const mergedNames = result.objects.filter((o) => o.kind === 'mergedFragmentGroup').flatMap((o) => o.mergedFrom ?? []);
      expect(mergedNames).toHaveLength(fixtureResult.fragmentCount);

      // Filenames are collision-free even though leaf/room/floor names repeat under different
      // parents in this fixture by design.
      const files = await listGlbFiles(outDir);
      expect(new Set(files).size).toBe(files.length);
      expect(files.length).toBe(normalCount + groupCount + standaloneCount);
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('fragment merge target with its OWN mesh (normal ancestor, not a meshless group): merges into the ancestor\'s existing output object, one file total', async () => {
    const outDir = await makeTempDir();
    const genDir = await makeTempDir();
    try {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const material = doc.createMaterial('Mat').setBaseColorFactor([0.7, 0.7, 0.7, 1]);
      const scene = doc.createScene('Scene');
      doc.getRoot().setDefaultScene(scene);

      function makeMeshNode(name: string, triangleMultiplier: number): { node: ReturnType<Document['createNode']>; triangleCount: number } {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let i = 0; i < triangleMultiplier; i++) {
          const base = positions.length / 3;
          positions.push(0, 0, i, 1, 0, i, 0, 1, i);
          indices.push(base, base + 1, base + 2);
        }
        const pos = doc.createAccessor(`${name}-pos`).setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
        const idx = doc.createAccessor(`${name}-idx`).setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
        const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(material);
        const mesh = doc.createMesh(name).addPrimitive(prim);
        return { node: doc.createNode(name).setMesh(mesh), triangleCount: triangleMultiplier };
      }

      const { node: bigValve } = makeMeshNode('BigValve', 100); // well above a floor of 50
      const { node: tinyBolt } = makeMeshNode('TinyBolt', 1); // well below
      bigValve.addChild(tinyBolt); // TinyBolt's parent is BigValve -- a MESH-bearing ancestor, not a meshless group
      scene.addChild(bigValve);

      const glbPath = path.join(genDir, 'model.glb');
      await new NodeIO().write(glbPath, doc);

      const linkageMap = new Map([
        ['BigValve', 'LINK-BIGVALVE'],
        ['TinyBolt', 'LINK-TINYBOLT'],
      ]);
      const result = await splitObjects(glbPath, outDir, linkageMap, { triangleFloor: 50 });

      expect(result.objects).toHaveLength(1);
      const [object] = result.objects;
      expect(object!.kind).toBe('normal');
      expect(object!.linkageKey).toBe('LINK-BIGVALVE');
      expect(object!.mergedFrom).toEqual([{ name: 'TinyBolt', linkageKey: 'LINK-TINYBOLT' }]);
      expect(object!.triangleCount).toBe(101); // 100 (BigValve) + 1 (TinyBolt)

      const files = await listGlbFiles(outDir);
      expect(files).toHaveLength(1);
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('PR #13 fix-up 2: fragment under a mesh-bearing FRAGMENT ancestor (not a normal one) merges into that ancestor\'s own output object, one file, one record', async () => {
    // Extends the ancestor-with-own-mesh rule (test above) to fragment ancestors too, not
    // just normal-sized ones. FragParent has no parent of its own (scene root), so it's the
    // top of this chain and becomes the merge target directly -- kind 'standaloneFragment',
    // now carrying mergedFrom for the child that climbed to it.
    const outDir = await makeTempDir();
    const genDir = await makeTempDir();
    try {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const material = doc.createMaterial('Mat').setBaseColorFactor([0.7, 0.7, 0.7, 1]);
      const scene = doc.createScene('Scene');
      doc.getRoot().setDefaultScene(scene);

      function makeMeshNode(name: string, triangleMultiplier: number): { node: ReturnType<Document['createNode']>; triangleCount: number } {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let i = 0; i < triangleMultiplier; i++) {
          const base = positions.length / 3;
          positions.push(0, 0, i, 1, 0, i, 0, 1, i);
          indices.push(base, base + 1, base + 2);
        }
        const pos = doc.createAccessor(`${name}-pos`).setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
        const idx = doc.createAccessor(`${name}-idx`).setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
        const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(material);
        const mesh = doc.createMesh(name).addPrimitive(prim);
        return { node: doc.createNode(name).setMesh(mesh), triangleCount: triangleMultiplier };
      }

      const { node: fragParent } = makeMeshNode('FragParent', 1); // sub-floor: a fragment, not 'normal'
      const { node: fragChild } = makeMeshNode('FragChild', 2); // also sub-floor
      fragParent.addChild(fragChild); // FragChild's parent is FragParent -- a mesh-bearing FRAGMENT, not a normal node
      scene.addChild(fragParent);

      const glbPath = path.join(genDir, 'model.glb');
      await new NodeIO().write(glbPath, doc);

      const result = await splitObjects(glbPath, outDir, new Map(), { triangleFloor: 50 });

      expect(result.objects).toHaveLength(1); // single output object -- no duplicate path/name records
      const [object] = result.objects;
      expect(object!.kind).toBe('standaloneFragment');
      expect(object!.path).toEqual(['FragParent']);
      expect(object!.mergedFrom).toEqual([{ name: 'FragChild', linkageKey: undefined }]);
      expect(object!.triangleCount).toBe(3); // 1 (FragParent) + 2 (FragChild)

      const files = await listGlbFiles(outDir);
      expect(files).toHaveLength(1);
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('PR #13 fix-up 2: a three-deep fragment-under-fragment-under-fragment chain resolves to ONE object at the topmost ancestor, no duplicate identities', async () => {
    // Deterministic bottom-up resolution (see classifyMeshNodes()'s resolveTarget doc
    // comment): each fragment climbs its own parent chain independently, converging on
    // whichever real target sits at the top -- here, FragGrandparent itself (its own parent
    // is the scene root, so nothing above it to climb to).
    const outDir = await makeTempDir();
    const genDir = await makeTempDir();
    try {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const material = doc.createMaterial('Mat').setBaseColorFactor([0.7, 0.7, 0.7, 1]);
      const scene = doc.createScene('Scene');
      doc.getRoot().setDefaultScene(scene);

      function makeMeshNode(name: string, triangleMultiplier: number): { node: ReturnType<Document['createNode']>; triangleCount: number } {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let i = 0; i < triangleMultiplier; i++) {
          const base = positions.length / 3;
          positions.push(0, 0, i, 1, 0, i, 0, 1, i);
          indices.push(base, base + 1, base + 2);
        }
        const pos = doc.createAccessor(`${name}-pos`).setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
        const idx = doc.createAccessor(`${name}-idx`).setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
        const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(material);
        const mesh = doc.createMesh(name).addPrimitive(prim);
        return { node: doc.createNode(name).setMesh(mesh), triangleCount: triangleMultiplier };
      }

      const { node: grandparent } = makeMeshNode('FragGrandparent', 1);
      const { node: parent } = makeMeshNode('FragParent', 2);
      const { node: child } = makeMeshNode('FragChild', 3);
      grandparent.addChild(parent);
      parent.addChild(child);
      scene.addChild(grandparent);

      const glbPath = path.join(genDir, 'model.glb');
      await new NodeIO().write(glbPath, doc);

      const result = await splitObjects(glbPath, outDir, new Map(), { triangleFloor: 50 });

      expect(result.objects).toHaveLength(1); // no duplicate identities anywhere in the chain
      const [object] = result.objects;
      expect(object!.kind).toBe('standaloneFragment');
      expect(object!.path).toEqual(['FragGrandparent']);
      expect(object!.triangleCount).toBe(6); // 1 + 2 + 3
      expect(object!.mergedFrom?.map((m) => m.name).sort()).toEqual(['FragChild', 'FragParent']);

      const files = await listGlbFiles(outDir);
      expect(files).toHaveLength(1);
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('fragment merge target that is a meshless pure-group node: separate synthetic group file, not merged into any sibling normal object', async () => {
    const { generateHierarchyFixture } = await loadGenerator();
    const genDir = await makeTempDir();
    const outDir = await makeTempDir();
    try {
      await generateHierarchyFixture(genDir, { buildingCount: 1, floorsPerBuilding: 1, roomsPerFloor: 1, objectsPerRoom: 6, fragmentProbability: 1 });
      // fragmentProbability: 1 -> every leaf in the one Room is a fragment, Room_0 itself has
      // no mesh -> exactly one mergedFragmentGroup object, at Room_0's own path.
      const result = await splitObjects(path.join(genDir, 'model.glb'), outDir, new Map(), { triangleFloor: 50 });

      expect(result.objects).toHaveLength(1);
      expect(result.objects[0]!.kind).toBe('mergedFragmentGroup');
      expect(result.objects[0]!.path).toEqual(['Building_0', 'Floor_0', 'Room_0']);
      expect(result.objects[0]!.mergedFrom).toHaveLength(6);
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('linkage keys round-trip by NODE NAME, and absence is never flagged -- a merged-group record lists each constituent\'s own key (or its absence) individually', async () => {
    const { generateHierarchyFixture } = await loadGenerator();
    const genDir = await makeTempDir();
    const outDir = await makeTempDir();
    try {
      await generateHierarchyFixture(genDir, { buildingCount: 1, floorsPerBuilding: 1, roomsPerFloor: 1, objectsPerRoom: 4, fragmentProbability: 0 });
      const linkageMap = new Map([['Valve', 'LINK-VALVE']]); // "Pump"/"Tank"/"Sensor" deliberately absent
      const result = await splitObjects(path.join(genDir, 'model.glb'), outDir, linkageMap, { triangleFloor: 50 });

      const valveObjects = result.objects.filter((o) => o.name === 'Valve');
      expect(valveObjects.length).toBeGreaterThan(0);
      for (const o of valveObjects) expect(o.linkageKey).toBe('LINK-VALVE');

      const pumpObjects = result.objects.filter((o) => o.name === 'Pump');
      expect(pumpObjects.length).toBeGreaterThan(0);
      for (const o of pumpObjects) expect(o.linkageKey).toBeUndefined();
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('world transform correctness: a rotated + non-uniformly-scaled leaf under a rotated ancestor bakes to the exact expected WORLD-SPACE vertex positions and normals, with an IDENTITY output node transform', async () => {
    // Real mago-3d-tiler v1.15.4 was confirmed (WSL spot-check, docs/phase5r/task2-findings.md)
    // to silently drop a node's rotation when its "matrix" property combines rotation with
    // non-uniform scale -- splitter.ts therefore bakes world-space geometry directly into
    // vertex data and ships an identity node transform (superseding the original
    // setMatrix()-based design; docs/phase5r/task2-kickoff-amendment.md item 2 as originally
    // signed off). This test proves the baking math itself is correct, independent of mago.
    const outDir = await makeTempDir();
    const genDir = await makeTempDir();
    try {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const material = doc.createMaterial('Mat').setBaseColorFactor([0.7, 0.7, 0.7, 1]);
      const scene = doc.createScene('Scene');
      doc.getRoot().setDefaultScene(scene);

      const { positions, indices } = box(1, 1, 1);
      // A single flat (constant per-vertex) normal is enough to prove the transform rule --
      // this is the exact non-uniform-scale case where naively transforming by the position
      // matrix (rather than the inverse-transpose) would silently point it the wrong way.
      const rawNormal: [number, number, number] = [0, 0, 1];
      const normals = new Float32Array([...rawNormal, ...rawNormal, ...rawNormal]);
      const pos = doc.createAccessor('leaf-pos').setType('VEC3').setArray(positions).setBuffer(buffer);
      const nrm = doc.createAccessor('leaf-nrm').setType('VEC3').setArray(normals).setBuffer(buffer);
      const idx = doc.createAccessor('leaf-idx').setType('SCALAR').setArray(indices).setBuffer(buffer);
      const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setIndices(idx).setMaterial(material);
      const mesh = doc.createMesh('Leaf').addPrimitive(prim);

      // Ancestor: 90 degrees about Z, translated away from the origin.
      const ancestor = doc
        .createNode('Ancestor')
        .setRotation([0, 0, Math.SQRT1_2, Math.SQRT1_2])
        .setTranslation([100, -50, 25]);
      // Leaf: its OWN rotation (30 degrees about X) and non-uniform scale, nested under Ancestor.
      const sin15 = Math.sin(Math.PI / 12);
      const cos15 = Math.cos(Math.PI / 12);
      const leaf = doc
        .createNode('Leaf')
        .setMesh(mesh)
        .setRotation([sin15, 0, 0, cos15])
        .setScale([2, 0.5, 3]) // non-uniform: exercises the position-vs-normal transform divergence directly
        .setTranslation([1, 2, 3]);
      ancestor.addChild(leaf);
      scene.addChild(ancestor);

      const worldMatrix = leaf.getWorldMatrix();
      const normalMatrix = normalMatrixFrom(worldMatrix)!;
      const expectedPositions: Vec3[] = [];
      for (let i = 0; i < 3; i++) {
        expectedPositions.push(transformPoint(worldMatrix, [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]));
      }
      const expectedNormal = normalize3(transformDirection(normalMatrix, rawNormal));

      const glbPath = path.join(genDir, 'model.glb');
      await new NodeIO().write(glbPath, doc);

      const result = await splitObjects(glbPath, outDir, new Map(), { triangleFloor: 0 });
      const leafObject = result.objects.find((o) => o.name === 'Leaf');
      expect(leafObject).toBeDefined();

      const readBack = await new NodeIO().read(path.join(outDir, leafObject!.file));
      const readBackScene = readBack.getRoot().getDefaultScene()!;
      const readBackNode = readBackScene.listChildren()[0]!;

      // Identity node transform -- geometry is already in world space.
      expect(readBackNode.getMatrix()).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

      const readBackMesh = readBackNode.getMesh()!;
      const readBackPrim = readBackMesh.listPrimitives()[0]!;
      const readBackPos = readBackPrim.getAttribute('POSITION')!;
      const readBackNrm = readBackPrim.getAttribute('NORMAL')!;

      for (let i = 0; i < 3; i++) {
        const actual = readBackPos.getElement(i, [0, 0, 0]);
        for (let axis = 0; axis < 3; axis++) expect(actual[axis]!).toBeCloseTo(expectedPositions[i]![axis]!, 5);
      }
      // Every vertex carries the SAME baked normal here (constant input normal) -- check all 3.
      for (let i = 0; i < 3; i++) {
        const actualNormal = readBackNrm.getElement(i, [0, 0, 0]);
        for (let axis = 0; axis < 3; axis++) expect(actualNormal[axis]!).toBeCloseTo(expectedNormal[axis]!, 5);
        expect(Math.hypot(...actualNormal)).toBeCloseTo(1, 5); // unit length survives
      }
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  // Streaming (each output GLB written to disk before the next is constructed, never an
  // accumulated array of output buffers) is a code-SHAPE requirement per
  // docs/phase5r/task2-kickoff-amendment.md-adjacent sign-off, not something a black-box test
  // against splitObjects() can observe from the outside without instrumenting internals in a
  // way that would defeat the point (splitObjects() intentionally doesn't expose its internal
  // NodeIO instance). Enforced structurally in splitter.ts's own single sequential
  // `for (const object of classified) { ...build...; await io.write(...); }` loop -- no
  // Promise.all over a pre-built array, no intermediate `objectDocs: Document[]` accumulator
  // -- and is meant to be read for in code review, not asserted here.
});
