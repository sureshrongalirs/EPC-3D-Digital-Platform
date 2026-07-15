import fsp from 'node:fs/promises';
import path from 'node:path';

import { Document, NodeIO, type Accessor, type Buffer as GltfBuffer, type Extension, type Material, type Node } from '@gltf-transform/core';
import { copyToDocument, createDefaultPropertyResolver } from '@gltf-transform/functions';

import { createCollisionTracker, encodeObjectFilename } from './objectIdentity.js';
import { type Mat4, type Vec3, normalMatrixFrom, normalize3, transformDirection, transformPoint } from './worldTransform.js';

/**
 * Task 2 (per-object pipeline reshape): explodes a single merged GLB (already
 * assimp-exported from the source FBX -- see fbx/index.ts) into one GLB per plant object,
 * feeding mago-3d-tiler a directory it can genuinely spatially subdivide (Task 0's
 * `docs/phase5r/task0-findings.md`: a directory of separate per-object GLBs produced 142 real
 * tiles; a single merged GLB never subdivided at all, only a fixed fake 4-tile LOD chain).
 *
 * "Object" granularity: any node carrying a mesh, not individual primitives. A node's
 * triangle count below `triangleFloor` is a "fragment" -- too small to be worth its own tile
 * -- which merges into its nearest named ancestor's output object rather than becoming (or
 * bloating the tileset with) its own tiny file. See `classifyMeshNodes`'s doc comment for the
 * exact merge rules, including the standalone-at-root case
 * (docs/phase5r/task2-kickoff-amendment.md item 2).
 *
 * Identity: `objectIdentity.ts`'s full-hierarchy-path encoding, matching the metadata.json
 * record for the same object -- collisions are handled there (including case-insensitively),
 * never here.
 *
 * Linkage keys (when present) are looked up by node NAME, never by path
 * (docs/phase5r/task2-kickoff-amendment.md item 3): the FBX-side parseFBXLinkages() map is
 * keyed by the FBX Model node's own (compound-name-split) name, which has no "RootNode"
 * wrapper segment -- assimp's exported GLB, by contrast, always has that synthetic wrapper as
 * the tree's top-level node (confirmed against a real client file), so the GLB *path* and the
 * FBX *name* are not directly comparable strings, only the bare node name is common to both.
 */

export interface SplitOptions {
  /** Nodes with fewer triangles than this are "fragments" that merge into their nearest
   * named ancestor rather than becoming their own output object. */
  triangleFloor: number;
  /** See config.ts's Config.splitterBlobWarnRatio doc comment. Optional (defaults to
   * DEFAULT_BLOB_WARN_RATIO below) since most callers of this module -- in particular the
   * large majority of this file's own unit tests -- have no stake in this specific guard and
   * shouldn't need to plumb a value through just to construct valid options. */
  blobWarnRatio?: number;
}

/** Default for SplitOptions.blobWarnRatio when a caller doesn't supply one -- matches
 * config.ts's Config.splitterBlobWarnRatio default exactly, so an unconfigured real run and
 * an options-light test both get the same guard behavior. */
const DEFAULT_BLOB_WARN_RATIO = 0.5;

export interface MergedSourceRef {
  name: string;
  linkageKey?: string;
}

export interface SplitObjectRecord {
  file: string;
  path: string[];
  name: string;
  kind: 'normal' | 'standaloneFragment' | 'mergedFragmentGroup';
  linkageKey?: string;
  triangleCount: number;
  mergedFrom?: MergedSourceRef[];
}

export interface SplitResult {
  objects: SplitObjectRecord[];
  metadataPath: string;
  warnings: string[];
}

interface WalkedNode {
  node: Node;
  path: string[];
  triangleCount: number;
  parentNode: Node | null;
}

interface WalkResult {
  meshNodes: WalkedNode[];
  visitIndexByNode: Map<Node, number>;
  pathByNode: Map<Node, string[]>;
}

function triangleCountOf(node: Node): number {
  const mesh = node.getMesh();
  if (!mesh) return 0;
  let count = 0;
  for (const primitive of mesh.listPrimitives()) {
    const indices = primitive.getIndices();
    count += (indices ? indices.getCount() : (primitive.getAttribute('POSITION')?.getCount() ?? 0)) / 3;
  }
  return count;
}

/**
 * assimp always wraps an FBX export in a single synthetic top-level node literally named
 * "RootNode" (confirmed against the real client file, `testdata/local/2 1.fbx` --
 * `scene.listChildren()` is `[RootNode]`, and every one of its 4,510 real objects is
 * `RootNode`'s direct child, never the scene's). The FBX source has no such node at all: every
 * `Model` connects straight to the FBX scene root (docs/phase5r/task2-kickoff-amendment.md
 * item 1's real-file inspection). Left unstripped, this wrapper defeats BOTH of that doc's
 * binding rules at once for every real assimp-exported file: (a) fragment classification never
 * sees `parentNode === null` (every real object's parent is the wrapper, not the scene), so the
 * "standalone at root" rule can never fire and thousands of legitimate root-level fragments
 * merge into one oversized blob instead; (b) `objectIdentity.ts`'s path-based filenames get a
 * spurious "RootNode__" prefix on every single object instead of "simply degrad[ing] to the
 * object's own bare name" as item 2 requires for a flat tree. Both were confirmed as real (not
 * hypothetical) via this task's own end-to-end run against the real client file -- see
 * docs/phase5r/task2-findings.md.
 *
 * Stripping is narrowly scoped to the exact evidenced shape (a lone, mesh-less, literally-
 * "RootNode"-named scene child) rather than "any sole meshless top-level child" -- the latter
 * would also swallow a legitimate single-building site (`generateHierarchyFixture` with
 * `buildingCount: 1`), which is a real grouping level, not an export artifact, and must still
 * be a valid fragment-merge target.
 *
 * PROVENANCE / DEVIATION: the Task 2 design-checkpoint sign-off explicitly decided the
 * opposite of this function ("RootNode stays in the path; no wrapper-stripping heuristic") --
 * this was reversed on real-file evidence gathered *after* that sign-off, without a check-back
 * before implementing (see the Task 2 PR description's deviations section). The name
 * "RootNode" is assimp's own convention, not a glTF or FBX standard -- this heuristic is
 * therefore assimp-specific and stops firing (falling back to the pre-fix, path-inclusive
 * behavior) if the FBX->GLB exporter this worker shells out to (assimp.ts) is ever swapped for
 * a different tool. Revisit this function if that happens.
 *
 * OBSERVABILITY (PR #13 fix-up): a fallback that stops firing is no longer *silent* --
 * `scene.listChildren().length > 1` (multi-root) is the healthy common case and never warns,
 * but a sole MESHLESS top-level child that isn't literally named "RootNode" pushes an
 * informational warning, since that shape is exactly the one this function is designed to
 * recognize and might just not be anticipating a renamed/different wrapper. This alone doesn't
 * prove anything went wrong (a real single-building site has the identical shape and is
 * correctly left alone) -- it is a heads-up, not an error. The load-bearing catch for the
 * actual failure mode (thousands of fragments welded into one oversized blob, regardless of
 * *why* they weren't split standalone) is the separate, cause-agnostic blob-ratio guard in
 * `splitObjects()`'s own write loop below.
 */
function resolveEffectiveRoots(sceneChildren: Node[], warnings: string[]): Node[] {
  const [only] = sceneChildren;
  if (sceneChildren.length !== 1) return sceneChildren; // multi-root: the healthy common case, never warn
  if (only!.getMesh()) return sceneChildren; // has its own mesh -- not a pure-wrapper candidate at all

  if (only!.getName() === 'RootNode') return only!.listChildren();

  warnings.push(
    `sole top-level scene child "${only!.getName()}" is meshless but not named "RootNode" -- not stripped as an export-tool wrapper (resolveEffectiveRoots() only recognizes that literal name). Every object beneath it will carry "${only!.getName()}" as a real path segment (and therefore a filename prefix) rather than the tree degrading to bare names on this branch. This is expected and correct if "${only!.getName()}" is a genuine single top-level grouping (e.g. a single-building site) -- but if it is actually a synthetic wrapper from a different exporter, this heuristic needs extending rather than silently mis-splitting the way the unstripped "RootNode" case did before this task's fix (docs/phase5r/task2-findings.md §6).`,
  );
  return sceneChildren;
}

/** Depth-first walk from the effective root nodes (see `resolveEffectiveRoots`) -- the scene
 * itself, and any stripped assimp "RootNode" wrapper, never contribute a path segment; any
 * other real named node does. Records every node's path and visit order (for deterministic
 * output ordering later), not just mesh-bearing ones, since a fragment's merge target is
 * frequently a meshless pure-group node that never appears in `meshNodes` itself. */
function walkTree(rootNodes: Node[]): WalkResult {
  const meshNodes: WalkedNode[] = [];
  const visitIndexByNode = new Map<Node, number>();
  const pathByNode = new Map<Node, string[]>();
  let counter = 0;

  function visit(node: Node, parentPath: string[], parentNode: Node | null): void {
    const nodePath = [...parentPath, node.getName()];
    pathByNode.set(node, nodePath);
    visitIndexByNode.set(node, counter++);
    if (node.getMesh()) {
      meshNodes.push({ node, path: nodePath, triangleCount: triangleCountOf(node), parentNode });
    }
    for (const child of node.listChildren()) visit(child, nodePath, node);
  }

  for (const root of rootNodes) visit(root, [], null);
  return { meshNodes, visitIndexByNode, pathByNode };
}

interface ClassifiedObject {
  kind: SplitObjectRecord['kind'];
  path: string[];
  sourceNodes: WalkedNode[];
  visitIndex: number;
}

/**
 * Classifies every mesh-bearing node as a "normal" object (>= triangleFloor) or a fragment,
 * then resolves each fragment's ultimate merge target via `resolveTarget` below:
 *
 * - No mesh-bearing ancestor anywhere above it (climbs all the way to a null parent) ->
 *   STANDALONE, keyed by the topmost fragment in that chain. Never merged into nothing, never
 *   dropped -- a root-level tiny object (or a whole chain of them) can be a real,
 *   individually-linkage-keyed cluster of plant parts.
 * - Nearest mesh-bearing ancestor is a "normal" node -> merges INTO that node's own output
 *   object (one file; the normal node's own geometry plus every fragment that climbs to it).
 * - Nearest mesh-bearing ancestor is ALSO a fragment (PR #13 fix-up 2: extends sign-off item
 *   4's "ancestor has its own mesh" rule to fragment ancestors too, not just normal ones) ->
 *   merges into THAT fragment's own resolved target, transitively -- a fragment-under-
 *   fragment-under-fragment chain of any depth all funnel into whichever real object sits at
 *   the top: the nearest normal ancestor if one exists along the chain, otherwise the nearest
 *   meshless ancestor, otherwise the topmost fragment itself. This makes a "duplicate
 *   path/name metadata record" (one for the parent fragment's own object, a separate one for
 *   a synthetic group keyed by that same parent) structurally impossible: there is now always
 *   exactly one merge target per chain, never two records sharing an identity.
 * - Nearest mesh-bearing ancestor doesn't exist, but a MESHLESS ancestor does (the common
 *   case: Room/Floor/Building-style grouping with no mesh of its own) -> merges into a
 *   synthetic group object, identified by that ancestor's own path, combining every fragment
 *   (or fragment-chain) that climbs to it.
 *
 * Previously (pre-fix-up-2) a fragment-under-fragment was a "known, deliberately unhandled"
 * case, folded into the meshless-group path with a dedicated warning and the parent fragment's
 * own geometry left out of the child's output object entirely. That warning is retired here,
 * not merely downgraded: this is no longer an unspecified or anomalous shape, it is a fully
 * resolved, deterministic, tested code path (see splitter.test.ts's fragment-under-fragment and
 * three-deep-chain tests) -- keeping a warning for routine, correctly-handled behavior would be
 * exactly the kind of warning-noise this task's own observability additions (PR #13 fix-up 1)
 * were designed to avoid.
 */
function classifyMeshNodes(meshNodes: WalkedNode[], pathByNode: Map<Node, string[]>, visitIndexByNode: Map<Node, number>, triangleFloor: number): ClassifiedObject[] {
  const normalNodes = new Set<Node>();
  const fragments: WalkedNode[] = [];
  const fragmentByNode = new Map<Node, WalkedNode>();
  for (const info of meshNodes) {
    if (info.triangleCount >= triangleFloor) normalNodes.add(info.node);
    else {
      fragments.push(info);
      fragmentByNode.set(info.node, info);
    }
  }

  const mergedIntoNormal = new Map<Node, WalkedNode[]>();
  const groups = new Map<Node, { path: string[]; fragments: WalkedNode[] }>();
  const standaloneGroups = new Map<Node, WalkedNode[]>();

  /** Deterministic bottom-up resolution: every fragment's target is computed independently
   * by climbing its OWN parent chain, so re-running against identical input always produces
   * identical groupings regardless of which order `fragments` happens to be iterated in. A
   * chain of fragments-under-fragments recurses through this same function once per link,
   * converging on whichever real target (normal node, meshless node, or the topmost
   * null-parented fragment) sits at the top -- see this function's own doc comment above. */
  function resolveTarget(fragment: WalkedNode): { kind: 'normal' | 'meshlessGroup' | 'standalone'; node: Node } {
    const parent = fragment.parentNode;
    if (parent === null) return { kind: 'standalone', node: fragment.node };
    if (normalNodes.has(parent)) return { kind: 'normal', node: parent };
    const parentFragment = fragmentByNode.get(parent);
    if (parentFragment) return resolveTarget(parentFragment);
    return { kind: 'meshlessGroup', node: parent };
  }

  for (const fragment of fragments) {
    const target = resolveTarget(fragment);
    if (target.kind === 'normal') {
      const list = mergedIntoNormal.get(target.node) ?? [];
      list.push(fragment);
      mergedIntoNormal.set(target.node, list);
    } else if (target.kind === 'standalone') {
      const list = standaloneGroups.get(target.node) ?? [];
      list.push(fragment);
      standaloneGroups.set(target.node, list);
    } else {
      let group = groups.get(target.node);
      if (!group) {
        group = { path: pathByNode.get(target.node) ?? [target.node.getName()], fragments: [] };
        groups.set(target.node, group);
      }
      group.fragments.push(fragment);
    }
  }

  const objects: ClassifiedObject[] = [];

  for (const info of meshNodes) {
    if (!normalNodes.has(info.node)) continue;
    const merged = mergedIntoNormal.get(info.node) ?? [];
    objects.push({
      kind: 'normal',
      path: info.path,
      sourceNodes: [info, ...merged],
      visitIndex: visitIndexByNode.get(info.node)!,
    });
  }

  for (const [rootNode, group] of standaloneGroups) {
    objects.push({
      kind: 'standaloneFragment',
      path: pathByNode.get(rootNode) ?? [rootNode.getName()],
      sourceNodes: group,
      visitIndex: visitIndexByNode.get(rootNode)!,
    });
  }

  for (const [groupNode, group] of groups) {
    objects.push({
      kind: 'mergedFragmentGroup',
      path: group.path,
      sourceNodes: group.fragments,
      visitIndex: visitIndexByNode.get(groupNode)!,
    });
  }

  objects.sort((a, b) => a.visitIndex - b.visitIndex);
  return objects;
}

function linkageKeyFor(nodeName: string, linkageMap: Map<string, string>): string | undefined {
  return linkageMap.get(nodeName);
}

function getElementVec3(accessor: Accessor, index: number): Vec3 {
  const out = accessor.getElement(index, [0, 0, 0]);
  return [out[0]!, out[1]!, out[2]!];
}

/** POSITION accessor rebuilt with every vertex transformed by the node's full world matrix
 * (`transformPoint`) -- the correct rule for points. */
function bakePositionAccessor(targetDoc: Document, source: Accessor, buffer: GltfBuffer, worldMatrix: Mat4): Accessor {
  const count = source.getCount();
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = transformPoint(worldMatrix, getElementVec3(source, i));
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return targetDoc.createAccessor().setType('VEC3').setArray(out).setBuffer(buffer);
}

/** NORMAL accessor rebuilt with every vertex transformed by the inverse-transpose of the
 * world matrix's upper-left 3x3 and renormalized (`worldTransform.ts`'s doc comment explains
 * why this differs from `bakePositionAccessor`'s rule whenever scale is non-uniform). */
function bakeNormalAccessor(targetDoc: Document, source: Accessor, buffer: GltfBuffer, normalMatrix: readonly number[]): Accessor {
  const count = source.getCount();
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = normalize3(transformDirection(normalMatrix, getElementVec3(source, i)));
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return targetDoc.createAccessor().setType('VEC3').setArray(out).setBuffer(buffer);
}

/** Any attribute NOT affected by a spatial transform (indices, TEXCOORD_*, COLOR_*, ...) --
 * cloned verbatim, decoupled from the source Document's own buffer. */
function copyAccessorRaw(targetDoc: Document, source: Accessor, buffer: GltfBuffer): Accessor {
  const array = source.getArray();
  if (!array) throw new Error('accessor has no array data to copy');
  const cloned = array.slice();
  return targetDoc
    .createAccessor()
    .setType(source.getType())
    .setArray(cloned)
    .setBuffer(buffer)
    .setNormalized(source.getNormalized());
}

/**
 * Builds one standalone Document containing every `sourceNodes`' mesh, with every POSITION and
 * NORMAL baked directly into WORLD-space vertex data and an IDENTITY node transform -- not
 * `Node.setMatrix(node.getWorldMatrix())` on the node itself (the original design; see
 * docs/phase5r/task2-findings.md for why: real mago-3d-tiler v1.15.4 was confirmed, via a WSL
 * spot-check with real vertex-data evidence, to silently DROP a node's rotation whenever its
 * "matrix" property combines rotation with non-uniform scale -- it appears to decompose the
 * matrix and only recovers scale correctly. Baking removes matrix decomposition from the
 * pipeline entirely: mago never receives a non-trivial node transform to misinterpret, only
 * finished geometry and an identity node).
 *
 * A node's position in the merged source Document is the product of every ancestor's
 * transform, not just its own; copying only the node's local transform (dropping ancestors)
 * would silently misplace the object in world space -- `Node.getWorldMatrix()` is what
 * supplies the full composed transform being baked in here.
 */
async function buildObjectDocument(sourceDoc: Document, sourceNodes: WalkedNode[], warnings: string[]): Promise<Document> {
  const targetDoc = new Document();
  for (const sourceExtension of sourceDoc.getRoot().listExtensionsUsed()) {
    const ctor = sourceExtension.constructor as new (doc: Document) => Extension;
    const targetExtension = targetDoc.createExtension(ctor);
    if (sourceExtension.isRequired()) targetExtension.setRequired(true);
  }

  const scene = targetDoc.createScene('Scene');
  targetDoc.getRoot().setDefaultScene(scene);
  const buffer = targetDoc.createBuffer();
  const resolve = createDefaultPropertyResolver(targetDoc, sourceDoc);

  for (const { node } of sourceNodes) {
    const mesh = node.getMesh();
    if (!mesh) continue;

    const worldMatrix = node.getWorldMatrix();
    let normalMatrix = normalMatrixFrom(worldMatrix);
    if (!normalMatrix) {
      warnings.push(
        `node "${node.getName()}" has a singular (dimension-collapsing) world transform -- normals could not be inverse-transposed correctly; falling back to the raw upper-left 3x3 (lighting may look subtly wrong for this object).`,
      );
      normalMatrix = [worldMatrix[0]!, worldMatrix[1]!, worldMatrix[2]!, worldMatrix[4]!, worldMatrix[5]!, worldMatrix[6]!, worldMatrix[8]!, worldMatrix[9]!, worldMatrix[10]!];
    }

    const targetMesh = targetDoc.createMesh(mesh.getName());
    for (const sourcePrimitive of mesh.listPrimitives()) {
      const targetPrimitive = targetDoc.createPrimitive().setMode(sourcePrimitive.getMode());

      const sourceMaterial = sourcePrimitive.getMaterial();
      if (sourceMaterial) {
        const map = copyToDocument(targetDoc, sourceDoc, [sourceMaterial], resolve);
        targetPrimitive.setMaterial(map.get(sourceMaterial) as Material);
      }

      const sourceIndices = sourcePrimitive.getIndices();
      if (sourceIndices) targetPrimitive.setIndices(copyAccessorRaw(targetDoc, sourceIndices, buffer));

      if (sourcePrimitive.getAttribute('TANGENT')) {
        warnings.push(
          `node "${node.getName()}"'s primitive has a TANGENT attribute -- tangent-space baking is not yet implemented (no fixture or real client file inspected so far has needed it, see docs/phase5r/task2-kickoff-amendment.md's real-file summary: zero textures). Dropped rather than shipped un-re-orthogonalized and wrong -- normal mapping will be visually incorrect for this object until this is implemented (see worldTransform.ts's doc comment for the correct rule).`,
        );
      }

      for (const semantic of sourcePrimitive.listSemantics()) {
        if (semantic === 'TANGENT') continue; // dropped, warned above -- never shipped un-re-orthogonalized
        const sourceAccessor = sourcePrimitive.getAttribute(semantic);
        if (!sourceAccessor) continue;
        if (semantic === 'POSITION') {
          targetPrimitive.setAttribute(semantic, bakePositionAccessor(targetDoc, sourceAccessor, buffer, worldMatrix));
        } else if (semantic === 'NORMAL') {
          targetPrimitive.setAttribute(semantic, bakeNormalAccessor(targetDoc, sourceAccessor, buffer, normalMatrix));
        } else {
          targetPrimitive.setAttribute(semantic, copyAccessorRaw(targetDoc, sourceAccessor, buffer));
        }
      }

      targetMesh.addPrimitive(targetPrimitive);
    }

    // Identity transform -- every vertex is already baked into world space above.
    const targetNode = targetDoc.createNode(node.getName()).setMesh(targetMesh);
    scene.addChild(targetNode);
  }

  return targetDoc;
}

/**
 * Explodes `mergedGlbPath` into one GLB per object under `outDir`, plus a `metadata.json`
 * sidecar in the same directory. Streaming by construction: each output Document is built,
 * written to disk, and released before the next one is constructed -- classification
 * (`classifyMeshNodes`, lightweight: node references and triangle counts only) happens
 * up front, but the actual glTF Document + vertex-buffer construction for the O(object count)
 * heavy step is strictly one-at-a-time, never an accumulated array of output buffers held in
 * memory at once.
 */
export async function splitObjects(mergedGlbPath: string, outDir: string, linkageMap: Map<string, string>, options: SplitOptions): Promise<SplitResult> {
  await fsp.mkdir(outDir, { recursive: true });

  const sourceDoc = await new NodeIO().read(mergedGlbPath);
  const scene = sourceDoc.getRoot().getDefaultScene() ?? sourceDoc.getRoot().listScenes()[0];
  if (!scene) throw new Error(`${mergedGlbPath} has no scene to split`);

  const warnings: string[] = [];
  const { meshNodes, visitIndexByNode, pathByNode } = walkTree(resolveEffectiveRoots(scene.listChildren(), warnings));
  const classified = classifyMeshNodes(meshNodes, pathByNode, visitIndexByNode, options.triangleFloor);

  // Symptom guard (PR #13 fix-up): catches "thousands of legitimate objects welded into one
  // unsubdividable blob" (docs/phase5r/task2-findings.md §6) by its OUTCOME (one output object
  // dominating the total mesh-object count), not by trying to enumerate every possible cause
  // the way resolveEffectiveRoots()'s own informational warning does -- this fires regardless
  // of whether the cause is an unrecognized wrapper name, a future classification bug, or
  // something not yet anticipated.
  const blobWarnRatio = options.blobWarnRatio ?? DEFAULT_BLOB_WARN_RATIO;
  const totalMeshObjects = meshNodes.length;

  const tracker = createCollisionTracker();
  const io = new NodeIO();
  const objects: SplitObjectRecord[] = [];

  for (const object of classified) {
    const file = encodeObjectFilename(object.path, tracker);
    const objectDoc = await buildObjectDocument(sourceDoc, object.sourceNodes, warnings);
    await io.write(path.join(outDir, file), objectDoc);

    const triangleCount = object.sourceNodes.reduce((sum, n) => sum + n.triangleCount, 0);
    const primaryName = object.path[object.path.length - 1] ?? object.sourceNodes[0]!.node.getName();

    const constituentCount = object.sourceNodes.length;
    if (totalMeshObjects > 0 && constituentCount > blobWarnRatio * totalMeshObjects) {
      warnings.push(
        `output object "${file}" (path: ${object.path.join('/')}) combines ${constituentCount} of ${totalMeshObjects} total mesh-bearing source object(s) (${((constituentCount / totalMeshObjects) * 100).toFixed(1)}%, over the ${(blobWarnRatio * 100).toFixed(0)}% threshold) into a single tile file -- this is the shape of the RootNode-wrapper bug this task fixed (docs/phase5r/task2-findings.md §6). A real, intentionally large fragment cluster is possible, but this magnitude warrants a manual look before trusting the split, not silent acceptance.`,
      );
    }

    if (object.kind === 'mergedFragmentGroup') {
      objects.push({
        file,
        path: object.path,
        name: primaryName,
        kind: object.kind,
        triangleCount,
        mergedFrom: object.sourceNodes.map((n) => ({ name: n.node.getName(), linkageKey: linkageKeyFor(n.node.getName(), linkageMap) })),
      });
    } else {
      const [primary, ...merged] = object.sourceNodes;
      objects.push({
        file,
        path: object.path,
        name: primaryName,
        kind: object.kind,
        linkageKey: linkageKeyFor(primary!.node.getName(), linkageMap),
        triangleCount,
        ...(merged.length > 0 ? { mergedFrom: merged.map((n) => ({ name: n.node.getName(), linkageKey: linkageKeyFor(n.node.getName(), linkageMap) })) } : {}),
      });
    }
  }

  if (objects.length === 0) {
    warnings.push(`${mergedGlbPath} produced zero output objects (no mesh-bearing nodes found) -- the tiles integrity gate will treat this as a hard failure (referencedCount === 0), not this module's job to gate.`);
  }

  const metadataPath = path.join(outDir, 'metadata.json');
  await fsp.writeFile(metadataPath, JSON.stringify({ version: 1, objects }, null, 2));

  return { objects, metadataPath, warnings };
}
