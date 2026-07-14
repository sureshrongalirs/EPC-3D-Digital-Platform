// Generates a synthetic plant-like grid of many small, distinct box meshes -- used by
// Phase 5R Task 0's mago-3d-tiler re-validation spike (docs/phase5r/task0-findings.md) to
// test whether a given mago-3d-tiler release actually subdivides a single merged GLB, or
// only a directory of separate per-object GLBs (see server/worker/src/adapters/tiles/
// magoTiler.ts's doc comment for the prior finding this re-checks). Never commit the
// generated output -- it's large by design (>50MB at production scale) and fully
// reproducible, matching CLAUDE.md invariant #8's spirit for synthetic fixtures. Re-run with:
//   node testdata/scripts/generate-plant-grid-fixture.mjs <outDir> <merged|split> [objectCount] [segments]
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
  const [outDir, mode, objectCountArg, segmentsArg] = process.argv.slice(2);
  if (!outDir || !mode) {
    console.error('usage: generate-plant-grid-fixture.mjs <outDir> <merged|split> [objectCount] [segments]');
    process.exitCode = 2;
    return;
  }
  const result = await generatePlantGridFixture(
    outDir,
    mode,
    objectCountArg ? Number(objectCountArg) : undefined,
    segmentsArg ? Number(segmentsArg) : undefined,
  );
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
