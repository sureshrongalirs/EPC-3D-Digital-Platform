import type { TileObjectMetadata } from '@plantscope/shared';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  computeHitBarycoord,
  computeTiledCentroids,
  indexMetadataByFile,
  resolveTiledPickMetadata,
  selectLoadBackend,
  tiledPickObjectId,
} from './tiles';

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

function makeSingleTriangleMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  // A simple XZ-plane triangle, sized 2x2, centered at the origin.
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 0, 0, 1], 3),
  );
  return new THREE.Mesh(geometry);
}

describe('computeHitBarycoord', () => {
  it('returns (1,0,0)-ish weighting for a hit exactly on vertex 0 (non-indexed geometry)', () => {
    const mesh = makeSingleTriangleMesh();
    const bary = computeHitBarycoord(mesh, 0, new THREE.Vector3(-1, 0, -1));
    expect(bary.x).toBeCloseTo(1, 5);
    expect(bary.y).toBeCloseTo(0, 5);
    expect(bary.z).toBeCloseTo(0, 5);
  });

  it('returns roughly equal weights for a hit at the triangle centroid', () => {
    const mesh = makeSingleTriangleMesh();
    const bary = computeHitBarycoord(mesh, 0, new THREE.Vector3(0, 0, -1 / 3));
    expect(bary.x).toBeCloseTo(1 / 3, 4);
    expect(bary.y).toBeCloseTo(1 / 3, 4);
    expect(bary.z).toBeCloseTo(1 / 3, 4);
  });

  it('resolves through an index buffer when the geometry is indexed', () => {
    const geometry = new THREE.BufferGeometry();
    // Vertex order deliberately scrambled in the position buffer; the index buffer restores
    // the same triangle winding computeHitBarycoord must resolve through.
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 1, -1, 0, -1, 1, 0, -1], 3),
    );
    geometry.setIndex([1, 2, 0]);
    const mesh = new THREE.Mesh(geometry);
    const bary = computeHitBarycoord(mesh, 0, new THREE.Vector3(-1, 0, -1));
    expect(bary.x).toBeCloseTo(1, 5);
  });

  // Guards the classic faceIndex -> vertex-index off-by-one: every test above only ever picks
  // faceIndex 0 on a single-triangle mesh, which can't distinguish "correctly resolves i0 =
  // faceIndex*3" from "always reads the first three vertices regardless of faceIndex". These
  // use a two-triangle mesh with the triangles placed far apart and non-overlapping, so an
  // off-by-one (reading triangle 0's vertices for a faceIndex-1 hit) would compute a barycoord
  // against the wrong, spatially-unrelated triangle -- not just a slightly-wrong weighting, a
  // sharply wrong one (components far outside the valid [0,1] simplex).
  it('resolves the SECOND triangle of a two-triangle non-indexed mesh (faceIndex 1, not 0)', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          // Triangle 0 (faceIndex 0): near the origin.
          0, 0, 0, 1, 0, 0, 0, 0, 1,
          // Triangle 1 (faceIndex 1): far away, non-overlapping.
          5, 0, 5, 6, 0, 5, 5, 0, 6,
        ],
        3,
      ),
    );
    const mesh = new THREE.Mesh(geometry);

    // Hit exactly triangle 1's first vertex (5,0,5) -- must resolve to (1,0,0), not the
    // nonsensical/out-of-range result reading triangle 0's vertices for this point would give.
    const bary = computeHitBarycoord(mesh, 1, new THREE.Vector3(5, 0, 5));
    expect(bary.x).toBeCloseTo(1, 5);
    expect(bary.y).toBeCloseTo(0, 5);
    expect(bary.z).toBeCloseTo(0, 5);

    // Triangle 0 itself is unaffected -- still resolves correctly at faceIndex 0.
    const baryTri0 = computeHitBarycoord(mesh, 0, new THREE.Vector3(0, 0, 0));
    expect(baryTri0.x).toBeCloseTo(1, 5);
  });

  it('resolves the SECOND triangle through an index buffer (faceIndex 1, indexed geometry)', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          0, 0, 0, 1, 0, 0, 0, 0, 1, // vertices 0-2: triangle 0's data
          5, 0, 5, 6, 0, 5, 5, 0, 6, // vertices 3-5: triangle 1's data
        ],
        3,
      ),
    );
    // Index buffer, not identity -- triangle 1 (faceIndex 1) is index entries [3,4,5] mapping
    // straight through here, but scrambling triangle 0's own winding ([2,0,1]) proves this
    // isn't accidentally passing via non-indexed fallback logic.
    geometry.setIndex([2, 0, 1, 3, 4, 5]);
    const mesh = new THREE.Mesh(geometry);

    const bary = computeHitBarycoord(mesh, 1, new THREE.Vector3(5, 0, 5));
    expect(bary.x).toBeCloseTo(1, 5);
    expect(bary.y).toBeCloseTo(0, 5);
    expect(bary.z).toBeCloseTo(0, 5);
  });
});

const OBJECT_1880: TileObjectMetadata = {
  file: 'Object_1880.glb',
  path: ['Object_1880'],
  name: 'Object_1880',
  kind: 'standaloneFragment',
  linkageKey: '5414 24846 22885 1064',
  triangleCount: 24,
};

const OBJECT_NO_LINKAGE: TileObjectMetadata = {
  file: 'Object_9999.glb',
  path: ['Object_9999'],
  name: 'Object_9999',
  kind: 'normal',
  triangleCount: 10,
};

describe('indexMetadataByFile', () => {
  it('indexes records by their file field', () => {
    const index = indexMetadataByFile([OBJECT_1880, OBJECT_NO_LINKAGE]);
    expect(index.get('Object_1880.glb')).toEqual(OBJECT_1880);
    expect(index.size).toBe(2);
  });
});

describe('tiledPickObjectId (design-checkpoint sign-off item 4)', () => {
  it('prefers linkageKey when present', () => {
    expect(tiledPickObjectId(OBJECT_1880)).toBe('5414 24846 22885 1064');
  });

  it('falls back to file when linkageKey is absent (linkage coverage is optional)', () => {
    expect(tiledPickObjectId(OBJECT_NO_LINKAGE)).toBe('Object_9999.glb');
  });
});

/** Fakes 3d-tiles-renderer's MeshFeatures/StructuralMetadata just enough to exercise
 * resolveTiledPickMetadata()'s own logic, mirroring the real classes' documented API
 * (getFeatures/getFeatureInfo/getPropertyTableData) without needing a real loaded glTF
 * document -- see MeshFeaturesLike/StructuralMetadataLike in tiles.ts. */
function attachFakeMeshFeatures(
  mesh: THREE.Mesh,
  opts: { featureId: number | null; tableIndex: number | null; propertyTable: Record<number, Record<string, unknown>> },
): void {
  mesh.userData.meshFeatures = {
    getFeatureInfo: () => [{ propertyTable: opts.tableIndex }],
    getFeatures: () => [opts.featureId],
  };
  mesh.userData.structuralMetadata = {
    getPropertyTableData: (_tableIndex: number, id: number) => opts.propertyTable[id] ?? {},
  };
}

describe('resolveTiledPickMetadata (Task 3 design checkpoint item 3 -- real mago identity mechanism)', () => {
  it('resolves a hit to its metadata.json record via feature id -> property table -> FileName', () => {
    const mesh = makeSingleTriangleMesh();
    attachFakeMeshFeatures(mesh, {
      featureId: 3,
      tableIndex: 0,
      propertyTable: { 3: { NodeName: 'Object_1880', FileName: 'Object_1880.glb', BatchId: '3', id: 'uuid-1' } },
    });
    const metadataByFile = indexMetadataByFile([OBJECT_1880]);

    const result = resolveTiledPickMetadata(
      { object: mesh, faceIndex: 0, point: new THREE.Vector3(-1, 0, -1) },
      metadataByFile,
    );

    expect(result).toEqual(OBJECT_1880);
  });

  it('returns null when the hit mesh has no meshFeatures/structuralMetadata userData (extensions not registered, or a tile predating them)', () => {
    const mesh = makeSingleTriangleMesh();
    const metadataByFile = indexMetadataByFile([OBJECT_1880]);
    const result = resolveTiledPickMetadata(
      { object: mesh, faceIndex: 0, point: new THREE.Vector3(-1, 0, -1) },
      metadataByFile,
    );
    expect(result).toBeNull();
  });

  it('returns null when the resolved FileName has no metadata.json entry', () => {
    const mesh = makeSingleTriangleMesh();
    attachFakeMeshFeatures(mesh, {
      featureId: 0,
      tableIndex: 0,
      propertyTable: { 0: { FileName: 'Object_UNKNOWN.glb' } },
    });
    const result = resolveTiledPickMetadata(
      { object: mesh, faceIndex: 0, point: new THREE.Vector3(-1, 0, -1) },
      indexMetadataByFile([OBJECT_1880]),
    );
    expect(result).toBeNull();
  });

  it('returns null when there is no metadata map at all', () => {
    const mesh = makeSingleTriangleMesh();
    attachFakeMeshFeatures(mesh, {
      featureId: 0,
      tableIndex: 0,
      propertyTable: { 0: { FileName: 'Object_1880.glb' } },
    });
    const result = resolveTiledPickMetadata({ object: mesh, faceIndex: 0, point: new THREE.Vector3(-1, 0, -1) }, null);
    expect(result).toBeNull();
  });

  it('returns null when faceIndex is null (no real triangle hit)', () => {
    const mesh = makeSingleTriangleMesh();
    attachFakeMeshFeatures(mesh, { featureId: 0, tableIndex: 0, propertyTable: {} });
    const result = resolveTiledPickMetadata(
      { object: mesh, faceIndex: null, point: new THREE.Vector3() },
      indexMetadataByFile([OBJECT_1880]),
    );
    expect(result).toBeNull();
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
