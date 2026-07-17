import type { TileObjectMetadata } from '@plantscope/shared';
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

// ---------------------------------------------------------------------------
// Tiled pick resolution (Task 3): supersedes the deleted resolveTiledObjectId, which
// resolved identity via the hit mesh's own `.name` walked up to the nearest named ancestor,
// matched against the linkage-map sidecar. That mechanism cannot work against real
// mago-3d-tiler output -- every real tile's mesh nodes are named generically ("RootNode" ->
// "BatchedRootNode" -> repeated "node", never a distinguishing name; confirmed by inspecting
// a real published tile's raw glTF JSON, Task 3 design-checkpoint finding #2) -- so it was
// dead code in practice, deleted rather than kept as a fallback (design-checkpoint sign-off
// item 3).
//
// mago DOES preserve real per-object identity, just via a different, standards-based
// mechanism (finding #1): every tile's mesh primitives carry the real OGC 3D Tiles
// EXT_mesh_features / EXT_structural_metadata extensions. Each primitive's `_FEATURE_ID_0`
// vertex attribute indexes into a per-tile property table (`mago_metadata_schema`) whose
// `FileName` column (e.g. "Object_1880.glb") matches metadata.json's own `file` field
// byte-for-byte -- confirmed against a real published tile's raw glTF JSON. 3d-tiles-
// renderer@0.4.28 ships loader plugins for both extensions (GLTFMeshFeaturesExtension,
// GLTFStructuralMetadataExtension -- registered in Viewer.ts's loadTilesModel()), which
// attach `MeshFeatures`/`StructuralMetadata` instances to `mesh.userData` on load.
// ---------------------------------------------------------------------------

/** Minimal shape of 3d-tiles-renderer's MeshFeatures class actually used here -- typed
 * locally rather than importing from '3d-tiles-renderer/plugins' so this module (and its
 * tests) don't need a real loaded glTF document to construct one. */
interface MeshFeaturesLike {
  getFeatures(triangle: number, barycoord: THREE.Vector3): Array<number | null>;
  getFeatureInfo(): Array<{ propertyTable: number | null }>;
}

/** Minimal shape of 3d-tiles-renderer's StructuralMetadata class actually used here -- see
 * MeshFeaturesLike's doc comment for why this is typed locally. */
interface StructuralMetadataLike {
  getPropertyTableData(tableIndex: number, id: number): Record<string, unknown>;
}

interface TiledMeshUserData {
  meshFeatures?: MeshFeaturesLike;
  structuralMetadata?: StructuralMetadataLike;
}

/**
 * Computes the barycentric coordinate of a world-space hit point within the given triangle
 * of `mesh`'s geometry -- the same vertex-index convention 3d-tiles-renderer's own
 * MeshFeatures.getFeatures() expects (indexed through geometry.index when present, else the
 * raw faceIndex*3 offset; matches three.js's own Raycaster triangle numbering, so a hit's
 * own `faceIndex` is directly usable here with no translation).
 */
export function computeHitBarycoord(mesh: THREE.Mesh, faceIndex: number, worldPoint: THREE.Vector3): THREE.Vector3 {
  const geometry = mesh.geometry;
  const index = geometry.getIndex();
  let i0 = faceIndex * 3;
  let i1 = faceIndex * 3 + 1;
  let i2 = faceIndex * 3 + 2;
  if (index) {
    i0 = index.getX(i0);
    i1 = index.getX(i1);
    i2 = index.getX(i2);
  }

  const position = geometry.getAttribute('position');
  const a = new THREE.Vector3().fromBufferAttribute(position, i0);
  const b = new THREE.Vector3().fromBufferAttribute(position, i1);
  const c = new THREE.Vector3().fromBufferAttribute(position, i2);

  const localPoint = mesh.worldToLocal(worldPoint.clone());
  const target = new THREE.Vector3();
  THREE.Triangle.getBarycoord(localPoint, a, b, c, target);
  return target;
}

/**
 * Resolves a raycast hit against tiled content to its metadata.json record (Task 3 design
 * checkpoint item 3). Tries every feature-id set the hit mesh's primitive declares (in
 * practice, mago-3d-tiler only ever emits one, `_FEATURE_ID_0`) and returns the first one
 * whose resolved `FileName` has a metadata.json entry.
 *
 * Returns null -- never a guess -- when the hit mesh carries no mesh-features/structural-
 * metadata userData at all (the extensions weren't registered on the loader, or this
 * particular tile has none), when no feature id resolves, or when the resolved FileName has
 * no metadata.json entry (a metadata.json that predates this object, or wasn't fetched).
 */
export function resolveTiledPickMetadata(
  hit: { object: THREE.Object3D; faceIndex: number | null; point: THREE.Vector3 },
  metadataByFile: Map<string, TileObjectMetadata> | null,
): TileObjectMetadata | null {
  if (!metadataByFile || hit.faceIndex == null) return null;
  if (!(hit.object instanceof THREE.Mesh)) return null;

  const userData = hit.object.userData as TiledMeshUserData;
  const meshFeatures = userData.meshFeatures;
  const structuralMetadata = userData.structuralMetadata;
  if (!meshFeatures || !structuralMetadata) return null;

  const barycoord = computeHitBarycoord(hit.object, hit.faceIndex, hit.point);
  const featureInfo = meshFeatures.getFeatureInfo();
  const features = meshFeatures.getFeatures(hit.faceIndex, barycoord);

  for (let i = 0; i < features.length; i++) {
    const featureId = features[i];
    const tableIndex = featureInfo[i]?.propertyTable;
    if (featureId == null || tableIndex == null) continue;

    const record = structuralMetadata.getPropertyTableData(tableIndex, featureId);
    const fileName = record.FileName;
    if (typeof fileName !== 'string') continue;

    const metadata = metadataByFile.get(fileName);
    if (metadata) return metadata;
  }

  return null;
}

/** Task 3 design-checkpoint sign-off item 4: PickResult.objectId prefers linkageKey (keeps
 * identity consistent with the GLB path and the linkage-map sidecar) but falls back to the
 * metadata record's own `file` when there is no linkage key -- linkage coverage is optional
 * (an FBX with no recovered Linkages properties, or an object mago genuinely has no
 * engineering join for), and `file` is unique by construction (splitter.ts's
 * collision-tracked encodeObjectFilename), so it's always safe as an identity fallback. */
export function tiledPickObjectId(metadata: TileObjectMetadata): string {
  return metadata.linkageKey ?? metadata.file;
}

/** Builds the file -> metadata record index resolveTiledPickMetadata() looks up against,
 * from a fetched metadata.json document. */
export function indexMetadataByFile(objects: readonly TileObjectMetadata[]): Map<string, TileObjectMetadata> {
  return new Map(objects.map((o) => [o.file, o]));
}
