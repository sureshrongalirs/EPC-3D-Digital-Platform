import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildSceneRegistry, searchSceneObjects, type SceneRegistry } from './sceneRegistry';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, '..', '..', '..', '..', 'testdata', 'fixtures', 'multi-object.glb');

function readFixtureArrayBuffer(): ArrayBuffer {
  const buffer = readFileSync(fixturePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

describe('buildSceneRegistry (synthetic multi-object.glb fixture)', () => {
  let registry: SceneRegistry;

  beforeAll(async () => {
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(readFixtureArrayBuffer(), '');
    registry = buildSceneRegistry(gltf.scene);
  });

  it('builds one tree node per top-level fixture object', () => {
    expect(registry.tree.children).toHaveLength(4);
    expect(registry.tree.children.map((c) => c.name).sort()).toEqual([
      'Pump-1',
      'Pump-2',
      'Tank-1',
      'Valve-1',
    ]);
  });

  it('registers every mesh as a flat, uniquely-keyed object', () => {
    expect(registry.objects.size).toBe(4);
    expect(new Set(registry.objects.keys()).size).toBe(4);
  });

  it('builds sorted, contiguous picking ranges covering every object', () => {
    expect(registry.pickingRanges).toHaveLength(4);
    for (let i = 1; i < registry.pickingRanges.length; i += 1) {
      expect(registry.pickingRanges[i]!.start).toBe(registry.pickingRanges[i - 1]!.end);
    }
    expect(registry.pickingProxy).not.toBeNull();
  });

  it('searches objects by substring', () => {
    const pumps = searchSceneObjects(registry.objects, 'pump');
    expect(pumps.map((o) => o.name).sort()).toEqual(['Pump-1', 'Pump-2']);

    const valves = searchSceneObjects(registry.objects, 'Valve');
    expect(valves).toHaveLength(1);
    expect(valves[0]!.name).toBe('Valve-1');

    expect(searchSceneObjects(registry.objects, 'nonexistent')).toHaveLength(0);
  });

  it('computes a sane world-space bbox for each object', () => {
    // Tank-1: half-extents [1, 1.5, 1] translated to [3, 0, 1] in testdata/scripts/generate-multi-object-glb.mjs.
    const tank = [...registry.objects.values()].find((o) => o.name === 'Tank-1');
    expect(tank).toBeDefined();
    expect(tank!.bbox.min.x).toBeCloseTo(2);
    expect(tank!.bbox.max.x).toBeCloseTo(4);
    expect(tank!.bbox.min.y).toBeCloseTo(-1.5);
    expect(tank!.bbox.max.y).toBeCloseTo(1.5);
    expect(tank!.bbox.min.z).toBeCloseTo(0);
    expect(tank!.bbox.max.z).toBeCloseTo(2);
    expect(tank!.centroid.x).toBeCloseTo(3);
    expect(tank!.centroid.y).toBeCloseTo(0);
    expect(tank!.centroid.z).toBeCloseTo(1);
  });
});
