// Generates synthetic plant-like fixtures for Phase 5R:
// - generatePlantGridFixture(mode: 'merged'|'split'): Task 0's mago-3d-tiler re-validation
//   spike (docs/phase5r/task0-findings.md) -- tests whether a given mago-3d-tiler release
//   actually subdivides a single merged GLB, or only a directory of separate per-object GLBs
//   (see server/worker/src/adapters/tiles/magoTiler.ts's doc comment for the prior finding
//   this re-checks).
// - generateHierarchyFixture(): Task 2's per-object splitter test fixture -- a single merged
//   GLB with a 4-level-deep Building/Floor/Room/leaf hierarchy, duplicate node names under
//   different parents, and a seeded mix of normal vs. sub-floor-fragment leaf objects.
// Never commit generated output -- it's large by design at production scale and fully
// reproducible, matching CLAUDE.md invariant #8's spirit for synthetic fixtures. Re-run with:
//   node testdata/scripts/generate-plant-grid-fixture.mjs <outDir> <merged|split> [objectCount] [segments]
//   node testdata/scripts/generate-plant-grid-fixture.mjs <outDir> hierarchy [seed]
import { mkdir } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';

/**
 * A subdivided box: `segments` quads per edge per face, so mesh density (and therefore
 * per-object byte size) is tunable independently of object count -- needed to hit a >50MB
 * total at thousands-of-objects scale without each object being a trivial 12-triangle box
 * (which would top out well under 2MB total for 5,000 objects).
 * @param {[number, number, number]} halfExtents
 * @param {number} segments
 */
function subdividedBoxGeometry([hx, hy, hz], segments) {
  const positions = [];
  const indices = [];
  const faces = [
    { axis: 'x', sign: 1 },
    { axis: 'x', sign: -1 },
    { axis: 'y', sign: 1 },
    { axis: 'y', sign: -1 },
    { axis: 'z', sign: 1 },
    { axis: 'z', sign: -1 },
  ];

  for (const face of faces) {
    const baseIndex = positions.length / 3;
    for (let j = 0; j <= segments; j++) {
      for (let i = 0; i <= segments; i++) {
        const u = (i / segments) * 2 - 1;
        const v = (j / segments) * 2 - 1;
        let x = 0;
        let y = 0;
        let z = 0;
        if (face.axis === 'x') {
          x = face.sign * hx;
          y = v * hy;
          z = u * hz * face.sign;
        } else if (face.axis === 'y') {
          y = face.sign * hy;
          x = u * hx;
          z = v * hz * face.sign;
        } else {
          z = face.sign * hz;
          x = u * hx * face.sign;
          y = v * hy;
        }
        positions.push(x, y, z);
      }
    }
    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        const a = baseIndex + j * (segments + 1) + i;
        const b = a + 1;
        const c = a + (segments + 1);
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function gridPosition(index, cols, spacing) {
  const x = (index % cols) * spacing;
  const z = Math.floor(index / cols) * spacing;
  return [x, 0, z];
}

/**
 * Deterministic seeded PRNG (mulberry32) -- Task 2's splitter fixture (see
 * generateHierarchyFixture below) needs reproducible-but-not-trivially-patterned pseudo-
 * randomness (which leaf slots get a sub-floor fragment) so re-running with the same seed
 * produces byte-identical output, per this task's spec.
 * @param {number} seed
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NORMAL_LEAF_TYPES = ['Valve', 'Pump', 'Tank', 'Sensor'];
const FRAGMENT_LEAF_TYPES = ['Frag_Bolt', 'Frag_Bracket', 'Frag_Gasket'];

/**
 * A synthetic 4-level-deep plant hierarchy: Scene -> Building_N -> Floor_N -> Room_N -> leaf
 * object. Leaf node *names* repeat verbatim under different Room parents (drawn from a fixed
 * pool, `NORMAL_LEAF_TYPES`/`FRAGMENT_LEAF_TYPES`), and Room/Floor names repeat verbatim under
 * different Floor/Building parents too (`Room_0` exists under every Floor, `Floor_0` under
 * every Building) -- this is the Task 2 splitter's actual test case: a node's *name* is never
 * a unique identity, only its full hierarchy path is (Task 2 spec item 1's "filename =
 * deterministic encoding of the node's hierarchy path", not the leaf name alone).
 *
 * Each room's leaves are a deterministic (seeded) mix of "normal" objects
 * (`normalSegments`-density boxes, `12 * normalSegments^2` triangles each) and "fragment"
 * objects (`fragmentSegments`-density boxes, `12 * fragmentSegments^2` triangles each,
 * `fragmentSegments` far lower) -- a downstream splitter's triangle floor is expected to
 * merge fragments into their parent Room rather than emit them as their own tile.
 *
 * Output is a single merged GLB (mode: 'hierarchy' only emits one file, unlike
 * generatePlantGridFixture's merged/split modes -- Task 2's splitter is what turns this one
 * file into per-object files, so the fixture itself has no reason to pre-split).
 *
 * @param {string} outDir
 * @param {object} [options]
 * @param {number} [options.seed]
 * @param {number} [options.buildingCount]
 * @param {number} [options.floorsPerBuilding]
 * @param {number} [options.roomsPerFloor]
 * @param {number} [options.objectsPerRoom]
 * @param {number} [options.fragmentProbability] fraction (0-1) of leaf slots that get a
 *   sub-floor fragment instead of a normal object.
 * @param {number} [options.normalSegments]
 * @param {number} [options.fragmentSegments]
 */
export async function generateHierarchyFixture(outDir, options = {}) {
  const {
    seed = 42,
    buildingCount = 2,
    floorsPerBuilding = 2,
    roomsPerFloor = 2,
    objectsPerRoom = 4,
    fragmentProbability = 0.3,
    normalSegments = 4,
    fragmentSegments = 1,
  } = options;

  await mkdir(outDir, { recursive: true });
  const rng = mulberry32(seed);

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  doc.getRoot().setDefaultScene(scene);
  const material = doc.createMaterial('DefaultMaterial').setBaseColorFactor([0.7, 0.7, 0.7, 1]);

  const normalTriangleCount = 12 * normalSegments * normalSegments;
  const fragmentTriangleCount = 12 * fragmentSegments * fragmentSegments;

  const buildingSpacing = 40;
  const floorSpacing = 10;
  const roomSpacing = 6;
  const leafSpacing = 1.5;

  let normalObjectCount = 0;
  let fragmentCount = 0;
  let uid = 0;

  function addLeaf(parent, isFragment, index, translation) {
    const typePool = isFragment ? FRAGMENT_LEAF_TYPES : NORMAL_LEAF_TYPES;
    const name = typePool[index % typePool.length];
    const segments = isFragment ? fragmentSegments : normalSegments;
    const { positions, indices } = subdividedBoxGeometry([0.5, 0.5, 0.5], segments);
    uid += 1;
    const positionAccessor = doc.createAccessor(`leaf-${uid}-positions`).setType('VEC3').setArray(positions).setBuffer(buffer);
    const indexAccessor = doc.createAccessor(`leaf-${uid}-indices`).setType('SCALAR').setArray(indices).setBuffer(buffer);
    const primitive = doc.createPrimitive().setAttribute('POSITION', positionAccessor).setIndices(indexAccessor).setMaterial(material);
    const mesh = doc.createMesh(name).addPrimitive(primitive);
    const node = doc.createNode(name).setMesh(mesh).setTranslation(translation);
    parent.addChild(node);
    if (isFragment) fragmentCount += 1;
    else normalObjectCount += 1;
  }

  for (let b = 0; b < buildingCount; b++) {
    const building = doc.createNode(`Building_${b}`).setTranslation([b * buildingSpacing, 0, 0]);
    scene.addChild(building);

    for (let f = 0; f < floorsPerBuilding; f++) {
      const floor = doc.createNode(`Floor_${f}`).setTranslation([0, f * floorSpacing, 0]);
      building.addChild(floor);

      for (let r = 0; r < roomsPerFloor; r++) {
        const room = doc.createNode(`Room_${r}`).setTranslation([r * roomSpacing, 0, 0]);
        floor.addChild(room);

        const cols = Math.ceil(Math.sqrt(objectsPerRoom));
        for (let i = 0; i < objectsPerRoom; i++) {
          const isFragment = rng() < fragmentProbability;
          const translation = gridPosition(i, cols, leafSpacing);
          addLeaf(room, isFragment, i, translation);
        }
      }
    }
  }

  const outFile = path.join(outDir, 'model.glb');
  await new NodeIO().write(outFile, doc);
  const stat = await fsp.stat(outFile);

  return {
    mode: 'hierarchy',
    seed,
    buildingCount,
    floorsPerBuilding,
    roomsPerFloor,
    objectsPerRoom,
    depth: 4, // Building -> Floor -> Room -> leaf, below the implicit Scene root
    totalObjects: normalObjectCount + fragmentCount,
    normalObjectCount,
    fragmentCount,
    normalTriangleCount,
    fragmentTriangleCount,
    fileCount: 1,
    totalBytes: stat.size,
  };
}

/**
 * @param {string} outDir
 * @param {'merged' | 'split'} mode
 * @param {number} [objectCount]
 * @param {number} [segments]
 * @returns {Promise<{ mode: string, objectCount: number, fileCount: number, totalBytes: number }>}
 */
export async function generatePlantGridFixture(outDir, mode, objectCount = 6000, segments = 7) {
  await mkdir(outDir, { recursive: true });
  const cols = Math.ceil(Math.sqrt(objectCount));
  const spacing = 3;
  const halfExtents = [1, 1, 1];

  if (mode === 'merged') {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene('Scene');
    doc.getRoot().setDefaultScene(scene);
    // A material is required here, not cosmetic: mago-3d-tiler's loader silently treats
    // unmaterialed primitives as contributing zero nodes ("Total Node Count 0" -> "Tileset
    // root node children is null or empty"), confirmed via a minimal single-quad repro during
    // Phase 5R Task 0. Real assimp-exported GLBs always carry a material per primitive, which
    // is why that path never hit this; a from-scratch synthetic fixture has to match that or
    // it isn't representative of real input.
    const material = doc.createMaterial('DefaultMaterial').setBaseColorFactor([0.7, 0.7, 0.7, 1]);

    for (let i = 0; i < objectCount; i++) {
      const name = `Object_${String(i).padStart(5, '0')}`;
      const { positions, indices } = subdividedBoxGeometry(halfExtents, segments);
      const positionAccessor = doc.createAccessor(`${name}-positions`).setType('VEC3').setArray(positions).setBuffer(buffer);
      const indexAccessor = doc.createAccessor(`${name}-indices`).setType('SCALAR').setArray(indices).setBuffer(buffer);
      const primitive = doc.createPrimitive().setAttribute('POSITION', positionAccessor).setIndices(indexAccessor).setMaterial(material);
      const mesh = doc.createMesh(name).addPrimitive(primitive);
      const node = doc.createNode(name).setMesh(mesh).setTranslation(gridPosition(i, cols, spacing));
      scene.addChild(node);
    }

    const outFile = path.join(outDir, 'model.glb');
    await new NodeIO().write(outFile, doc);
    const stat = await fsp.stat(outFile);
    return { mode, objectCount, fileCount: 1, totalBytes: stat.size };
  }

  if (mode === 'split') {
    let totalBytes = 0;
    const io = new NodeIO();
    for (let i = 0; i < objectCount; i++) {
      const name = `Object_${String(i).padStart(5, '0')}`;
      const doc = new Document();
      const buffer = doc.createBuffer();
      const scene = doc.createScene('Scene');
      doc.getRoot().setDefaultScene(scene);
      const material = doc.createMaterial('DefaultMaterial').setBaseColorFactor([0.7, 0.7, 0.7, 1]);
      const { positions, indices } = subdividedBoxGeometry(halfExtents, segments);
      const positionAccessor = doc.createAccessor('positions').setType('VEC3').setArray(positions).setBuffer(buffer);
      const indexAccessor = doc.createAccessor('indices').setType('SCALAR').setArray(indices).setBuffer(buffer);
      const primitive = doc.createPrimitive().setAttribute('POSITION', positionAccessor).setIndices(indexAccessor).setMaterial(material);
      const mesh = doc.createMesh(name).addPrimitive(primitive);
      const node = doc.createNode(name).setMesh(mesh).setTranslation(gridPosition(i, cols, spacing));
      scene.addChild(node);

      const outFile = path.join(outDir, `${name}.glb`);
      await io.write(outFile, doc);
      const stat = await fsp.stat(outFile);
      totalBytes += stat.size;
    }
    return { mode, objectCount, fileCount: objectCount, totalBytes };
  }

  throw new Error(`unknown mode: ${mode} (expected 'merged' or 'split')`);
}

async function main() {
  const [outDir, mode, arg1, arg2] = process.argv.slice(2);
  if (!outDir || !mode) {
    console.error(
      'usage: generate-plant-grid-fixture.mjs <outDir> <merged|split> [objectCount] [segments]\n' +
        '       generate-plant-grid-fixture.mjs <outDir> hierarchy [seed]',
    );
    process.exitCode = 2;
    return;
  }

  if (mode === 'hierarchy') {
    const result = await generateHierarchyFixture(outDir, arg1 ? { seed: Number(arg1) } : undefined);
    console.log(
      `wrote ${result.fileCount} file(s), ${result.totalObjects} objects ` +
        `(${result.normalObjectCount} normal + ${result.fragmentCount} fragment), depth=${result.depth}, ` +
        `${(result.totalBytes / (1024 * 1024)).toFixed(2)}MB to ${outDir} (mode=hierarchy, seed=${result.seed})`,
    );
    return;
  }

  const result = await generatePlantGridFixture(outDir, mode, arg1 ? Number(arg1) : undefined, arg2 ? Number(arg2) : undefined);
  console.log(
    `wrote ${result.fileCount} file(s), ${result.objectCount} objects, ` +
      `${(result.totalBytes / (1024 * 1024)).toFixed(1)}MB to ${outDir} (mode=${result.mode})`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
