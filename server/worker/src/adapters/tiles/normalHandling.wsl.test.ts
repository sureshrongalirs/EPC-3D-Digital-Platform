import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { isMagoTilerAvailable, runMagoTiler } from './magoTiler.js';
import { splitObjects } from './splitter.js';

/**
 * Commits, as a re-runnable WSL-gated test, the "mago-3d-tiler discards per-vertex NORMAL
 * data" finding recorded in docs/phase5r/task2-findings.md §3 -- previously only demonstrated
 * via ad-hoc scripts during Task 2 implementation, never preserved in the repo (PR #13
 * verification pass, item 2: "so the finding is reproducible, not folklore"). Requires a real
 * mago-3d-tiler binary (java + the jar) -- does NOT need assimp, since the input here is
 * hand-built directly via @gltf-transform/core, not converted from a real FBX.
 */

const magoTilerAvailable = await isMagoTilerAvailable();

async function readFirstMeshNormalsAndPositions(glbPath: string): Promise<{ positions: [number, number, number][]; normals: [number, number, number][] | null }> {
  const doc = await new NodeIO().read(glbPath);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]!;
  let found: { positions: [number, number, number][]; normals: [number, number, number][] | null } | undefined;

  function visit(node: import('@gltf-transform/core').Node): void {
    if (found) return;
    const mesh = node.getMesh();
    if (mesh) {
      const prim = mesh.listPrimitives()[0]!;
      const posAcc = prim.getAttribute('POSITION')!;
      const nrmAcc = prim.getAttribute('NORMAL');
      const positions: [number, number, number][] = [];
      const normals: [number, number, number][] = [];
      for (let i = 0; i < posAcc.getCount(); i++) {
        const p = posAcc.getElement(i, [0, 0, 0]);
        positions.push([p[0]!, p[1]!, p[2]!]);
      }
      if (nrmAcc) {
        for (let i = 0; i < nrmAcc.getCount(); i++) {
          const n = nrmAcc.getElement(i, [0, 0, 0]);
          normals.push([n[0]!, n[1]!, n[2]!]);
        }
      }
      found = { positions, normals: nrmAcc ? normals : null };
    }
    for (const child of node.listChildren()) visit(child);
  }
  for (const root of scene.listChildren()) visit(root);
  return found!;
}

function length3(v: readonly [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-normal-handling-'));
}

describe.skipIf(!magoTilerAvailable)('real mago-3d-tiler NORMAL handling (skipped if mago-3d-tiler is not installed)', () => {
  it('discards per-vertex NORMAL data and recomputes a flat per-face normal from output geometry, rather than transforming/preserving the baked NORMAL attribute', async () => {
    const genDir = await makeTempDir();
    const splitDir = await makeTempDir();
    const tilesDir = await makeTempDir();
    try {
      // Three deliberately DISTINCT, individually-normalized, non-geometric normals -- none
      // equal to the flat face normal of the triangle they sit on. If mago preserved (even
      // under some transform) the NORMAL attribute, the three tile-content vertices would stay
      // distinct from one another. If mago recomputes flat per-face normals, all three collapse
      // to one identical value -- the exact geometric cross-product normal of the output
      // triangle.
      const doc = new Document();
      const buffer = doc.createBuffer();
      const material = doc.createMaterial('Mat').setBaseColorFactor([0.7, 0.7, 0.7, 1]);
      const scene = doc.createScene('Scene');
      doc.getRoot().setDefaultScene(scene);

      const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
      const n0: [number, number, number] = [0.267, 0.535, 0.802];
      const n1: [number, number, number] = [-0.302, 0.905, 0.302];
      const n2: [number, number, number] = [0.455, -0.569, 0.683];
      const normals = new Float32Array([...n0, ...n1, ...n2]);
      const indices = new Uint16Array([0, 1, 2]);
      const pos = doc.createAccessor('p').setType('VEC3').setArray(positions).setBuffer(buffer);
      const nrm = doc.createAccessor('n').setType('VEC3').setArray(normals).setBuffer(buffer);
      const idx = doc.createAccessor('i').setType('SCALAR').setArray(indices).setBuffer(buffer);
      const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setIndices(idx).setMaterial(material);
      const mesh = doc.createMesh('Tri').addPrimitive(prim);
      const node = doc.createNode('Tri').setMesh(mesh).setTranslation([10, 20, 30]);
      scene.addChild(node);

      const glbPath = path.join(genDir, 'model.glb');
      await new NodeIO().write(glbPath, doc);

      const splitResult = await splitObjects(glbPath, splitDir, new Map(), { triangleFloor: 0 });
      expect(splitResult.objects).toHaveLength(1);

      // Pre-mago: the splitter's own baked output must still carry the three DISTINCT input
      // normals (this baking step is independently verified correct by
      // worldTransform.test.ts/splitter.test.ts's "world transform correctness" test -- this
      // assertion is a sanity check that this test's own fixture reached mago correctly, not a
      // re-proof of the baking math itself).
      const preMago = await readFirstMeshNormalsAndPositions(path.join(splitDir, splitResult.objects[0]!.file));
      expect(preMago.normals).not.toBeNull();
      const [pre0, pre1, pre2] = preMago.normals!;
      expect(pre0).not.toEqual(pre1);
      expect(pre1).not.toEqual(pre2);

      const runResult = await runMagoTiler(splitDir, tilesDir, { maxTriangleCount: 5000 });
      expect(runResult.exitCode).toBe(0);

      const dataDir = path.join(tilesDir, 'data');
      const tileFiles = (await fsp.readdir(dataDir)).filter((f) => f.endsWith('.glb'));
      expect(tileFiles.length).toBeGreaterThan(0);
      // Deepest LOD tile (highest digit-string, matches this task's other real-mago scripts'
      // convention of reading RC0000-style leaf content) -- any tile works since there's only
      // one object; pick the longest filename (deepest LOD) deterministically.
      const leafTile = tileFiles.sort((a, b) => b.length - a.length)[0]!;
      const postMago = await readFirstMeshNormalsAndPositions(path.join(dataDir, leafTile));

      expect(postMago.normals).not.toBeNull();
      const [post0, post1, post2] = postMago.normals!;

      // The core finding: all three post-mago vertices carry the SAME normal -- the three
      // distinct pre-mago inputs did not survive.
      expect(post0).toEqual(post1);
      expect(post1).toEqual(post2);

      // Unit length survives (it's a freshly-computed unit normal, not a preserved one).
      expect(length3(post0!)).toBeCloseTo(1, 5);

      // The post-mago normal is exactly the geometric (cross-product) face normal of the
      // post-mago output triangle's own positions -- proving RECOMPUTATION, not corruption or
      // an unrelated transform.
      const [p0, p1, p2] = postMago.positions as [[number, number, number], [number, number, number], [number, number, number]];
      const e1: [number, number, number] = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const e2: [number, number, number] = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const cross: [number, number, number] = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const crossLen = length3(cross);
      const geometricNormal: [number, number, number] = [cross[0] / crossLen, cross[1] / crossLen, cross[2] / crossLen];
      const dot = post0![0] * geometricNormal[0] + post0![1] * geometricNormal[1] + post0![2] * geometricNormal[2];
      expect(Math.abs(dot)).toBeCloseTo(1, 3); // parallel or anti-parallel (winding-order sign only)
    } finally {
      await fsp.rm(genDir, { recursive: true, force: true });
      await fsp.rm(splitDir, { recursive: true, force: true });
      await fsp.rm(tilesDir, { recursive: true, force: true });
    }
  }, 60_000);
});
