import * as THREE from 'three';

/**
 * Pure helpers for the OGC 3D Tiles backend (CLAUDE.md invariant #4), extracted out of
 * Viewer.ts so they're unit-testable without a live WebGLRenderer/canvas -- Viewer's own
 * constructor needs a real WebGL context (see apiSurface.test.ts's comment), so anything
 * that doesn't strictly need one lives here instead, same rationale as picking.ts/
 * sceneRegistry.ts.
 */

/** Decides which backend loadModel() should use for a given catalog record -- 'tiles' only
 * when the server explicitly says so; a null artifactType (a revision published before this
 * field existed) or 'glb' both fall back to the existing GLTFLoader path. */
export function selectLoadBackend(record: { artifactType: 'glb' | 'tiles' | null }): 'glb' | 'tiles' {
  return record.artifactType === 'tiles' ? 'tiles' : 'glb';
}

/**
 * Resolves a raycast hit against tiled content to a Linkage key. Tiled meshes have no
 * contiguous triangle-index ranges the way the GLB path's picking proxy does (tiles stream in
 * and out independently, and mago-3d-tiler's per-tile mesh layout can't be assumed stable),
 * so this instead walks up from the hit object to the nearest ancestor with a non-empty
 * `.name` (set from the source glTF node/mesh name) and looks that up in the linkage-map
 * sidecar. Returns null (not a guess) when the hit object has no named ancestor, or when the
 * linkage map has no entry for that name (no linkage map at all, or that node had no
 * recovered Linkage key).
 */
export function resolveTiledObjectId(hitObject: THREE.Object3D, linkageMap: Record<string, string> | null): string | null {
  let named: THREE.Object3D | null = hitObject;
  while (named && !named.name) named = named.parent;
  if (!named?.name) return null;
  return linkageMap?.[named.name] ?? null;
}

export interface ComponentBboxInput {
  linkageKey: string;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
}

/** Computes each component's world-space centroid from its bbox -- used for tiled models'
 * getObjectScreenCentroids() (see Viewer.ts), since tiled objects can span tiles that aren't
 * currently streamed in and so have no live three.js geometry to read a centroid off of the
 * way the GLB path's objectRecords do. Entries with no bbox (never recovered, e.g. a
 * georef-only or metadata-only job) are skipped, not defaulted to origin. */
export function computeTiledCentroids(componentBboxes: readonly ComponentBboxInput[]): Map<string, THREE.Vector3> {
  const centroids = new Map<string, THREE.Vector3>();
  for (const entry of componentBboxes) {
    if (!entry.bboxMin || !entry.bboxMax) continue;
    centroids.set(
      entry.linkageKey,
      new THREE.Vector3(
        (entry.bboxMin[0] + entry.bboxMax[0]) / 2,
        (entry.bboxMin[1] + entry.bboxMax[1]) / 2,
        (entry.bboxMin[2] + entry.bboxMax[2]) / 2,
      ),
    );
  }
  return centroids;
}
