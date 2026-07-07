import type { ObjectSummary, TreeNode } from '@plantscope/shared';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { PickRange } from './picking';

export interface SceneObjectRecord {
  id: string;
  name: string;
  mesh: THREE.Mesh;
  bbox: THREE.Box3;
  centroid: THREE.Vector3;
}

export interface SceneRegistry {
  tree: TreeNode;
  objects: Map<string, SceneObjectRecord>;
  pickingRanges: PickRange[];
  /** Invisible merged geometry used only for O(log n) raycasting — never rendered. */
  pickingProxy: THREE.Mesh | null;
}

/** World-space position+index-only copy of a mesh's geometry, for the picking proxy merge. */
function toPickingGeometry(geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4): THREE.BufferGeometry {
  const position = geometry.attributes['position'];
  if (!position) {
    throw new Error('Mesh geometry is missing a position attribute');
  }

  const picking = new THREE.BufferGeometry();
  picking.setAttribute('position', position.clone());

  if (geometry.index) {
    picking.setIndex(geometry.index.clone());
  } else {
    const count = position.count;
    const index = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) index[i] = i;
    picking.setIndex(new THREE.BufferAttribute(index, 1));
  }

  picking.applyMatrix4(matrixWorld);
  return picking;
}

/**
 * Traverses a parsed glTF scene (e.g. `gltf.scene`), building:
 * - the model tree (mirrors the node hierarchy),
 * - a flat object registry keyed by object id (world bbox + centroid + renderable mesh),
 * - sorted, contiguous picking ranges for {@link resolveObjectByTriangleIndex},
 * - a single merged, invisible "picking proxy" mesh for fast whole-model raycasting.
 */
export function buildSceneRegistry(root: THREE.Object3D): SceneRegistry {
  const objects = new Map<string, SceneObjectRecord>();
  const pickingRanges: PickRange[] = [];
  const proxyGeometries: THREE.BufferGeometry[] = [];
  const usedIds = new Set<string>();
  let triangleCursor = 0;

  function uniqueId(base: string): string {
    let id = base;
    let suffix = 1;
    while (usedIds.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return id;
  }

  function visit(node: THREE.Object3D): TreeNode {
    let selfId: string;
    const selfName = node.name || 'Node';

    if (node instanceof THREE.Mesh) {
      const id = uniqueId(node.name || `object-${objects.size}`);
      selfId = id;

      node.updateWorldMatrix(true, false);
      const bbox = new THREE.Box3().setFromObject(node);
      const centroid = bbox.getCenter(new THREE.Vector3());
      objects.set(id, { id, name: selfName, mesh: node, bbox, centroid });

      const geometry = node.geometry;
      const triCount = geometry.index
        ? geometry.index.count / 3
        : (geometry.attributes['position']?.count ?? 0) / 3;
      const start = triangleCursor;
      const end = start + triCount;
      pickingRanges.push({ start, end, objectId: id });
      triangleCursor = end;

      proxyGeometries.push(toPickingGeometry(geometry, node.matrixWorld));
    } else {
      selfId = uniqueId(`group-${node.name || 'group'}`);
    }

    const children = node.children.map(visit);
    return { id: selfId, name: selfName, children };
  }

  const rootChildren = root.children.map(visit);
  const tree: TreeNode = { id: 'model', name: root.name || 'Model', children: rootChildren };

  let pickingProxy: THREE.Mesh | null = null;
  if (proxyGeometries.length > 0) {
    const merged = mergeGeometries(proxyGeometries, false);
    pickingProxy = new THREE.Mesh(merged);
    pickingProxy.visible = false;
    for (const geom of proxyGeometries) geom.dispose();
  }

  return { tree, objects, pickingRanges, pickingProxy };
}

export function searchSceneObjects(
  objects: ReadonlyMap<string, SceneObjectRecord>,
  substring: string,
): ObjectSummary[] {
  const needle = substring.toLowerCase();
  const results: ObjectSummary[] = [];
  for (const record of objects.values()) {
    if (record.name.toLowerCase().includes(needle)) {
      results.push({ id: record.id, name: record.name });
    }
  }
  return results;
}
