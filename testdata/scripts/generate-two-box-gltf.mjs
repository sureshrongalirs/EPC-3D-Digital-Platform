// Generates testdata/fixtures/two-box.gltf (+ a sibling .bin buffer file): a minimal
// synthetic glTF in the JSON + external-buffer variant (as opposed to the single-file
// binary .glb the other fixture script produces), used to confirm @plantscope/core's
// loadModel handles .gltf's external-resource resolution the same way it handles .glb.
// Re-run with:
//   node testdata/scripts/generate-two-box-gltf.mjs
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Document, NodeIO } from '@gltf-transform/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'fixtures');
const outFile = path.join(outDir, 'two-box.gltf');

/** @param {[number, number, number]} halfExtents */
function boxGeometry([hx, hy, hz]) {
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
    { name: 'Box-A', position: [-1, 0, 0], halfExtents: [0.5, 0.5, 0.5] },
    { name: 'Box-B', position: [1, 0, 0], halfExtents: [0.4, 0.4, 0.4] },
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

  // NodeIO infers format from the output path's extension: `.gltf` writes the JSON +
  // external-buffer(s) variant (a sibling .bin here), `.glb` writes single-file binary.
  const io = new NodeIO();
  await io.write(outFile, doc);
  console.log(`wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
