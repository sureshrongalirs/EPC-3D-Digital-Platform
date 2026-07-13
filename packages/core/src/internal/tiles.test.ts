import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { computeTiledCentroids, resolveTiledObjectId, selectLoadBackend } from './tiles';

describe('selectLoadBackend (artifact_type routing)', () => {
  it('selects "tiles" when the server record says artifactType is tiles', () => {
    expect(selectLoadBackend({ artifactType: 'tiles' })).toBe('tiles');
  });

  it('selects "glb" when artifactType is glb', () => {
    expect(selectLoadBackend({ artifactType: 'glb' })).toBe('glb');
  });

  it('selects "glb" for a null artifactType (a revision published before this field existed)', () => {
    expect(selectLoadBackend({ artifactType: null })).toBe('glb');
  });
});

describe('resolveTiledObjectId (tiled-pick linkage-map lookup)', () => {
  const fixtureLinkageMap = {
    'Pump-1': 'LINK-1001',
    'Valve-1': 'LINK-1002',
  };

  it('resolves a direct hit on a named mesh via the linkage map', () => {
    const mesh = new THREE.Mesh();
    mesh.name = 'Pump-1';
    expect(resolveTiledObjectId(mesh, fixtureLinkageMap)).toBe('LINK-1001');
  });

  it('walks up to the nearest named ancestor when the hit object itself is unnamed', () => {
    const group = new THREE.Group();
    group.name = 'Valve-1';
    const child = new THREE.Mesh();
    group.add(child);
    expect(resolveTiledObjectId(child, fixtureLinkageMap)).toBe('LINK-1002');
  });

  it('returns null when no ancestor has a name at all', () => {
    const parent = new THREE.Group();
    const child = new THREE.Mesh();
    parent.add(child);
    expect(resolveTiledObjectId(child, fixtureLinkageMap)).toBeNull();
  });

  it('returns null when the named ancestor has no entry in the linkage map', () => {
    const mesh = new THREE.Mesh();
    mesh.name = 'Tank-1';
    expect(resolveTiledObjectId(mesh, fixtureLinkageMap)).toBeNull();
  });

  it('returns null when there is no linkage map at all', () => {
    const mesh = new THREE.Mesh();
    mesh.name = 'Pump-1';
    expect(resolveTiledObjectId(mesh, null)).toBeNull();
  });
});

describe('computeTiledCentroids (tiled getObjectScreenCentroids source)', () => {
  it('computes the midpoint centroid for each component with a bbox, using a fixture components response', () => {
    const fixture = [
      { linkageKey: 'LINK-1001', bboxMin: [0, 0, 0] as [number, number, number], bboxMax: [2, 4, 6] as [number, number, number] },
      { linkageKey: 'LINK-1002', bboxMin: [-1, -1, -1] as [number, number, number], bboxMax: [1, 1, 1] as [number, number, number] },
    ];

    const centroids = computeTiledCentroids(fixture);

    expect(centroids.size).toBe(2);
    expect(centroids.get('LINK-1001')).toEqual(new THREE.Vector3(1, 2, 3));
    expect(centroids.get('LINK-1002')).toEqual(new THREE.Vector3(0, 0, 0));
  });

  it('skips components with no bbox (never recovered) rather than defaulting to origin', () => {
    const fixture = [{ linkageKey: 'LINK-NO-BBOX', bboxMin: null, bboxMax: null }];
    const centroids = computeTiledCentroids(fixture);
    expect(centroids.has('LINK-NO-BBOX')).toBe(false);
    expect(centroids.size).toBe(0);
  });
});
