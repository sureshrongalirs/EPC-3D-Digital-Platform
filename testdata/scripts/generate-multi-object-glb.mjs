// Generates testdata/fixtures/multi-object.glb: a small synthetic GLB with several
// distinct box meshes, used by packages/core's registry test. Re-run with:
//   node testdata/scripts/generate-multi-object-glb.mjs
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Document, NodeIO } from '@gltf-transform/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'fixtures');
const outFile = path.join(outDir, 'multi-object.glb');

/** @param {[number, number, number]} halfExtents */
function boxGeometry([hx, hy, hz]) {
  // 8 corners, 12 triangles (36 indices), matching three.js winding (CCW, outward normals
  // are not required for this fixture — only geometry/topology is exercised by the tests).
  const positions = new Float32Array([
    -hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz, // back face
    -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz, // front face
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, // back
    4, 6, 5, 4, 7, 6, // front
    0, 4, 5, 0, 5, 1, // bottom
    3, 2, 6, 3, 6, 7, // top
    0, 3, 7, 0, 7, 4, // left
    1, 5, 6, 1, 6, 2, // right
  ]);
  return { positions, indices };
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');

  /** @type {{ name: string, position: [number, number, number], halfExtents: [number, number, number] }[]} */
  const objects = [
    { name: 'Pump-1', position: [-3, 0, 0], halfExtents: [0.5, 0.5, 0.5] },
    { name: 'Pump-2', position: [-1, 0, 0], halfExtents: [0.4, 0.6, 0.4] },
    { name: 'Valve-1', position: [1, 0, 0], halfExtents: [0.3, 0.3, 0.3] },
    { name: 'Tank-1', position: [3, 0, 1], halfExtents: [1, 1.5, 1] },
  ];

  for (const obj of objects) {
    const { positions, indices } = boxGeometry(obj.halfExtents);

    const positionAccessor = doc
      .createAccessor(`${obj.name}-positions`)
      .setType('VEC3')
      .setArray(positions)
      .setBuffer(buffer);
    const indexAccessor = doc
      .createAccessor(`${obj.name}-indices`)
      .setType('SCALAR')
      .setArray(indices)
      .setBuffer(buffer);

    const primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', positionAccessor)
      .setIndices(indexAccessor);

    const mesh = doc.createMesh(obj.name).addPrimitive(primitive);
    const node = doc.createNode(obj.name).setMesh(mesh).setTranslation(obj.position);
    scene.addChild(node);
  }

  const io = new NodeIO();
  await io.write(outFile, doc);
  console.log(`wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
