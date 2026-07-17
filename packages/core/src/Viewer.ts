import type {
  BoundingBox,
  ModelInfo,
  ObjectSummary,
  PickResult,
  TileMetadataDocument,
  TileObjectMetadata,
  TreeNode,
  Vector3Like,
} from '@plantscope/shared';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFMeshFeaturesExtension, GLTFStructuralMetadataExtension } from '3d-tiles-renderer/plugins';

import { createPanelSlot, createToolbarSlot } from './internal/domSlots';
import { EventBusImpl } from './internal/eventBus';
import { applyGeorefRotation, applyGeorefRotationIfStillCurrent } from './internal/georefTransform';
import { createColorizeMaterial, createHighlightMaterial } from './internal/highlight';
import { resolveObjectByTriangleIndex } from './internal/picking';
import { PluginHost } from './internal/pluginHost';
import { RestClientImpl } from './internal/restClient';
import { buildSceneRegistry, searchSceneObjects, type SceneObjectRecord } from './internal/sceneRegistry';
import {
  computeTiledCentroids,
  indexMetadataByFile,
  resolveTiledPickMetadata,
  selectLoadBackend,
  tiledPickObjectId,
} from './internal/tiles';
import type { PickRange } from './internal/picking';
import type { PlantScopePlugin, RestClient } from './plugin';

// ---------------------------------------------------------------------------
// 3d-tiles-renderer@0.4.28 type-declaration gaps (pre-existing, not introduced by Task 3 --
// confirmed via `git stash` against this branch's own pre-Task-3 code, which already hit the
// TilesGroup gap below at its own tilesRenderer.group call sites; never caught by CI because
// this repo's workflow only triggers on `push: [main]` / `pull_request`, and recent phase5r
// work landed on `dev` via direct fast-forward pushes, not merged PRs -- flagged in the
// design-checkpoint report for visibility, fixed narrowly here since it blocks typechecking
// this task's own new tilesRenderer.group.matrixWorld/updateMatrixWorld usage).
//
// Root cause (traced with `tsc --traceResolution`): three.js publishes no bundled .d.ts of
// its own (its package.json has no "types" field) -- @types/three supplies it, and resolves
// correctly for this package's OWN source files. But 3d-tiles-renderer's shipped .d.ts files
// (e.g. TilesGroup.d.ts's `import { Group } from 'three'`) resolve 'three' relative to THEIR
// OWN location inside node_modules, where TypeScript resolves the bare specifier straight to
// three's untyped .js entry file rather than falling back to @types/three -- so TilesGroup
// ends up seen as extending an almost-empty inferred type instead of the real THREE.Group.
// Runtime behavior is entirely unaffected (tilesRenderer.group IS a real THREE.Group at
// runtime) -- this cast documents that gap at its single choke point rather than sprinkling
// unexplained `as unknown as` casts at every call site.
function asObject3D(group: TilesRenderer['group']): THREE.Object3D {
  return group as unknown as THREE.Object3D;
}

// Separate gap, same class: GLTFMeshFeaturesExtension/GLTFStructuralMetadataExtension's
// shipped .d.ts declares no explicit constructor for either class (so TypeScript infers a
// 0-arg default), but both take a GLTFParser at runtime -- confirmed against their own .js
// source (`constructor(parser)` in each). Same kind of docs/types-vs-runtime gap this
// codebase already found for 3d-tiles-renderer's `stats`/`cachedBytes` (see
// TILES_CACHE_MAX_BYTES's doc comment below). Cast once, at the two construction sites,
// rather than widening the class types themselves.
type GLTFPluginCallback = Parameters<GLTFLoader['register']>[0];
type GLTFPluginParser = Parameters<GLTFPluginCallback>[0];
type GLTFPluginCtor = new (parser: GLTFPluginParser) => ReturnType<GLTFPluginCallback>;
const MeshFeaturesExtensionCtor = GLTFMeshFeaturesExtension as unknown as GLTFPluginCtor;
const StructuralMetadataExtensionCtor = GLTFStructuralMetadataExtension as unknown as GLTFPluginCtor;

export interface ViewerOptions {
  apiUrl?: string;
  /**
   * Override the RestClient handed to plugins via `PluginContext.rest`. Defaults to a
   * fetch-based client against `apiUrl`. Phase 2 plugins use this to inject an in-memory
   * mock (no real API server exists until Phase 3) — see `@plantscope/plugins`'
   * `createMockRestClient`.
   */
  restClient?: RestClient;
}

interface ObjectRecord extends SceneObjectRecord {
  originalMaterial: THREE.Material | THREE.Material[];
}

// DRACOLoader decoder assets are local, static files (see CLAUDE.md: no CDN at runtime).
// The host app is responsible for serving three's examples/jsm/libs/draco/ contents at
// this path — apps/demo does so from public/draco/.
const DRACO_DECODER_PATH = '/draco/';

// mago-3d-tiler's b3dm tile content is loaded through this same loader/manager pairing so
// DRACO decompression works for tiled content too (three.js's own DRACOLoader, not Cesium's
// -- see USAGE.md's "Adding DRACO Decompression Support"). ~1GB memory budget for the tile
// LRU cache (CLAUDE.md invariant #4's "same viewer" streaming requirement) -- only enforced
// on three.js r166+, which this package's three@^0.185.1 satisfies.
const TILES_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const TILES_CACHE_MIN_BYTES = 768 * 1024 * 1024;

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46]; // "glTF" — binary container's magic header

/**
 * A `.glb` is self-contained (magic header + embedded buffers/textures); a `.gltf` is JSON
 * text, optionally referencing external `.bin`/texture files. CLAUDE.md invariant #4: both
 * are handled by GLTFLoader, .fbx never is (worker-only, Phase 4).
 */
function detectFormatFromBuffer(buffer: ArrayBuffer): 'glb' | 'gltf' {
  const header = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  const isGlb = GLB_MAGIC.every((byte, i) => header[i] === byte);
  return isGlb ? 'glb' : 'gltf';
}

function detectFormatFromUrl(url: string): 'glb' | 'gltf' {
  return url.toLowerCase().endsWith('.gltf') ? 'gltf' : 'glb';
}

/** Minimal shape returned by GET /api/models/{id} that loadModel's server-pointer branch
 * actually needs -- narrower than the full ModelDto so callers don't have to fetch it
 * themselves first. */
interface ModelRecordResponse {
  name: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  artifactUrl: string | null;
  artifactType: 'glb' | 'tiles' | null;
  /** Task 3: Task 2's metadata.json sidecar (tiles-backed models only). */
  metadataUrl: string | null;
  error: string | null;
}

/** Minimal shape of GET /api/models/{id}/georef actually needed here -- a 404 (no georef
 * saved for this model) is caught and treated as "no rotation to apply", same as
 * MapGeorefPlugin's own fetch of this same endpoint. */
interface GeorefResponse {
  rotationDeg: number;
}

/** One entry of GET /api/components?model={id}&fields=bbox's response. */
interface ComponentBboxResponse {
  linkageKey: string;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
}

/** Third loadModel() input form: "load whatever the server currently has published for
 * this catalog id" (as opposed to a raw URL or in-memory bytes). Deliberately not the full
 * ModelInfo output type -- format/objectCount/bbox are recomputed from the loaded scene,
 * never supplied by the caller. */
export interface ModelPointer {
  id: string;
  name?: string;
}

function toSharedBoundingBox(box: THREE.Box3): BoundingBox {
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
}

function resolveContainer(container: string | HTMLElement): HTMLElement {
  if (typeof container !== 'string') return container;
  const el = document.querySelector<HTMLElement>(container);
  if (!el) throw new Error(`Viewer: no element matches selector "${container}"`);
  return el;
}

/**
 * Framework-agnostic viewer SDK. three.js is an internal implementation detail — it must
 * never appear in this class's public method/property types (see CLAUDE.md invariant #1).
 */
export class Viewer {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly gltfLoader: GLTFLoader;
  private readonly dracoLoader: DRACOLoader;
  private readonly raycaster: THREE.Raycaster;
  private readonly apiBaseUrl: string;
  private readonly restClient: RestClient;
  private readonly events: EventBusImpl;
  private readonly pluginHost: PluginHost;
  private readonly resizeObserver: ResizeObserver;
  private readonly highlightMaterial = createHighlightMaterial();

  private modelGroup: THREE.Group | null = null;
  private pickingProxy: THREE.Mesh | null = null;
  private pickingRanges: PickRange[] = [];
  private objectRecords = new Map<string, ObjectRecord>();
  private tree: TreeNode | null = null;
  private highlightedIds = new Set<string>();
  private colorizedIds = new Set<string>();
  private animationFrameId: number | null = null;
  private disposed = false;

  // OGC 3D Tiles backend (CLAUDE.md invariant #4) -- rendered into this *same* scene/camera,
  // never a second Viewer/canvas. activeBackend tracks which of the two is currently loaded
  // so pick()/getObjectScreenCentroids()/fitToModel() know which code path to use; loadModel()
  // itself decides which backend per-load from the server's artifactType, never the caller.
  private tilesRenderer: TilesRenderer | null = null;
  private activeBackend: 'glb' | 'tiles' = 'glb';
  // Fetched once per tiles model load (not per-pick/per-frame) -- see loadTilesModel().
  private tiledComponentCentroids: Map<string, THREE.Vector3> | null = null;
  // Task 3: metadata.json (Task 2), indexed by file -- the tiled pick-resolution join target
  // (see performTiledPick()/resolveTiledPickMetadata()). Supersedes tiledLinkageMap's own
  // role in pick resolution (metadata.json already carries linkageKey per object); the
  // linkage-map sidecar fetch above was removed for that reason -- see this task's design
  // checkpoint finding #2 for why the old name-based mechanism never worked against real
  // mago-3d-tiler output.
  private tiledMetadataByFile: Map<string, TileObjectMetadata> | null = null;

  constructor(container: string | HTMLElement, opts: ViewerOptions = {}) {
    this.container = resolveContainer(container);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(5, 10, 7.5);
    this.scene.add(sun);

    const { width, height } = this.getContainerSize();
    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 10000);
    this.camera.position.set(5, 5, 5);
    this.renderer.setSize(width, height, false);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(this.dracoLoader);

    this.raycaster = new THREE.Raycaster();
    this.apiBaseUrl = opts.apiUrl ?? '';
    this.restClient = opts.restClient ?? new RestClientImpl(this.apiBaseUrl);
    this.events = new EventBusImpl();
    this.pluginHost = new PluginHost(
      this,
      this.restClient,
      this.events,
      createToolbarSlot(this.container),
      createPanelSlot(this.container),
      this.container,
    );

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);
    this.renderer.domElement.addEventListener('click', this.handleClick);

    this.animate();
  }

  async loadModel(source: string | ArrayBuffer | ModelPointer): Promise<ModelInfo> {
    this.unloadModel();

    // Server-pointer form is the only one that can ever resolve to the tiles backend --
    // there is no such thing as an in-browser-loaded/local-file OGC 3D Tiles source in this
    // app (CLAUDE.md invariant #4: tiles only ever come from the Phase 4/5 worker's own
    // conversion, published and fetched via the catalog API). Fetched once, here, and reused
    // by the ModelPointer branch below for the 'glb' case rather than fetching it twice.
    let modelPointerRecord: ModelRecordResponse | undefined;
    if (typeof source === 'object' && 'id' in source) {
      const infoUrl = `${this.apiBaseUrl}/api/models/${source.id}`;
      const infoRes = await fetch(infoUrl);
      if (!infoRes.ok) throw new Error(`GET ${infoUrl} failed: ${infoRes.status}`);
      const record = (await infoRes.json()) as ModelRecordResponse;
      if (record.status === 'failed') {
        throw new Error(`model ${source.id} failed conversion: ${record.error ?? 'unknown error'}`);
      }
      if (!record.artifactUrl) {
        throw new Error(`model ${source.id} has no published artifact yet (status: ${record.status})`);
      }

      if (selectLoadBackend(record) === 'tiles') {
        const artifactUrl = `${this.apiBaseUrl}${record.artifactUrl}`;
        return this.loadTilesModel(artifactUrl, record.metadataUrl, source.id, source.name ?? record.name);
      }
      // Falls through to the existing GLTFLoader path below for 'glb' (or a null
      // artifactType, from a revision published before this field existed).
      modelPointerRecord = record;
    }

    let gltf: GLTF;
    let id: string;
    let name: string;
    let format: 'glb' | 'gltf';

    if (typeof source === 'string') {
      // loadAsync (not a manual fetch+parseAsync) resolves a .gltf JSON's relative external
      // resources (a sibling .bin, textures) against this URL itself — this is what makes
      // .gltf, not just self-contained .glb, work. See CLAUDE.md's note near invariant #4.
      gltf = await this.gltfLoader.loadAsync(source);
      id = generateId();
      name = source.split('/').pop() || 'model';
      format = detectFormatFromUrl(source);
    } else if (source instanceof ArrayBuffer) {
      // Raw bytes with no URL context — fine for a self-contained .glb, or a .gltf JSON
      // with only embedded (data-URI) resources. A .gltf referencing a separate sibling
      // .bin/texture file can't be resolved from bytes alone (nothing to resolve against).
      gltf = await this.gltfLoader.parseAsync(source, '');
      id = generateId();
      name = 'model';
      format = detectFormatFromBuffer(source);
    } else {
      // Server-pointer form: look up the catalog record for its artifactUrl rather than
      // assuming a binary-fetch route — server/api serves the actual bytes via the
      // Range-enabled /files/* static route, pointed to by ModelDto.artifactUrl. Already
      // fetched (and tiles-checked) above -- modelPointerRecord is always set on this branch.
      const record = modelPointerRecord!;
      const artifactUrl = `${this.apiBaseUrl}${record.artifactUrl}`;
      gltf = await this.gltfLoader.loadAsync(artifactUrl);
      id = source.id;
      name = source.name ?? record.name;
      format = detectFormatFromUrl(artifactUrl);
    }

    this.modelGroup = gltf.scene;
    this.scene.add(this.modelGroup);

    // Georef positioning (Task 3 design-checkpoint sign-off item 2): only the server-pointer
    // form has a stable catalog id with a real georef record to fetch -- a locally-loaded
    // file (drag-drop / raw ArrayBuffer / bare URL) has no such id, matching how loadModel()
    // already gates the tiles backend selection above. Before this task, this GLB path
    // applied no georef transform at all (see finding #4) -- this is what makes "same as the
    // GLB path" true for the tiles path's own positioning below, rather than aspirational.
    //
    // applyGeorefRotationIfStillCurrent (PR #14 verification's adversarial finding): the fetch
    // below is an unguarded await -- a second loadModel() call racing in while it's in flight
    // would already have replaced this.modelGroup by the time it resolves. loadedGroup is
    // captured now, before the await, so the guard can detect that and silently skip applying
    // a stale rotation rather than throwing (unloadModel() nulled this.modelGroup) or rotating
    // the wrong, superseding model.
    if (modelPointerRecord) {
      const loadedGroup = this.modelGroup;
      await applyGeorefRotationIfStillCurrent(loadedGroup, () => this.modelGroup, () => this.fetchGeorefRotationDeg(id));
    }

    const registry = buildSceneRegistry(this.modelGroup);
    this.tree = registry.tree;
    this.pickingRanges = registry.pickingRanges;
    this.pickingProxy = registry.pickingProxy;

    for (const [objectId, record] of registry.objects) {
      this.objectRecords.set(objectId, { ...record, originalMaterial: record.mesh.material });
    }

    const bbox = new THREE.Box3().setFromObject(this.modelGroup);
    const modelInfo: ModelInfo = {
      id,
      name,
      format,
      objectCount: this.objectRecords.size,
      bbox: toSharedBoundingBox(bbox),
    };

    this.fitToModel();
    this.events.emit('modelLoaded', modelInfo);
    this.pluginHost.notifyModelLoaded(modelInfo);

    return modelInfo;
  }

  /**
   * OGC 3D Tiles backend (CLAUDE.md invariant #4) -- rendered into this *same* scene/camera
   * as the GLB path, via 3DTilesRendererJS's `TilesRenderer`. Called only from loadModel()'s
   * server-pointer branch once the server has said this model's artifactType is 'tiles';
   * loadModel()'s own public signature/behavior is otherwise unchanged, so callers never know
   * which backend loaded.
   */
  private async loadTilesModel(tilesetUrl: string, metadataUrl: string | null, id: string, name: string): Promise<ModelInfo> {
    const tilesRenderer = new TilesRenderer(tilesetUrl);
    tilesRenderer.setCamera(this.camera);
    tilesRenderer.setResolutionFromRenderer(this.camera, this.renderer);

    // three.js's own DRACOLoader (not Cesium's -- this repo's earlier globe-view work found
    // Cesium's bundled decoder hangs silently on this worker's Draco output; three's decoder
    // has no such issue) decodes b3dm-embedded glTF content, reusing the same decoder
    // instance/path the GLB path already uses. See USAGE.md's "Adding DRACO Decompression
    // Support".
    const tilesGltfLoader = new GLTFLoader(tilesRenderer.manager);
    tilesGltfLoader.setDRACOLoader(this.dracoLoader);
    // Task 3 design-checkpoint finding #1: mago-3d-tiler embeds real per-object identity via
    // the standard EXT_mesh_features/EXT_structural_metadata extensions -- these plugins
    // attach MeshFeatures/StructuralMetadata instances to each loaded mesh's userData
    // (mesh.userData.meshFeatures / .structuralMetadata), which performTiledPick() reads.
    // Without registering these, GLTFLoader parses the extensions' raw JSON but exposes none
    // of it -- confirmed against gltf-transform's own NodeIO, which does exactly that (silent
    // drop + a "missing optional extension" warning) unless the extension is registered.
    tilesGltfLoader.register((parser) => new MeshFeaturesExtensionCtor(parser));
    tilesGltfLoader.register((parser) => new StructuralMetadataExtensionCtor(parser));
    tilesRenderer.manager.addHandler(/\.(gltf|glb)$/g, tilesGltfLoader);

    // ~1GB memory budget for the tile cache (task requirement) -- see TILES_CACHE_MAX_BYTES's
    // doc comment for the three.js version floor this needs.
    tilesRenderer.lruCache.minBytesSize = TILES_CACHE_MIN_BYTES;
    tilesRenderer.lruCache.maxBytesSize = TILES_CACHE_MAX_BYTES;

    // Debug event: loaded tile count + memory estimate, emitted after every update() tick (see
    // animate()) so a host app can wire up a live stats overlay if it wants one. `stats`/
    // `cachedBytes` exist per 3d-tiles-renderer's own docs but aren't in its shipped .d.ts
    // (a real gap between its docs and published types at this version) -- activeTiles and
    // getMemoryUsage() are both properly typed, so the byte estimate is summed from those
    // instead of relying on an untyped property that could disappear/rename without notice.
    tilesRenderer.addEventListener('update-after', () => {
      let cachedBytes = 0;
      for (const tile of tilesRenderer.activeTiles) cachedBytes += tilesRenderer.lruCache.getMemoryUsage(tile);
      this.events.emit('tilesDebug', {
        loadedTileCount: tilesRenderer.activeTiles.size,
        cachedBytes,
      });
    });

    const rootTilesetLoaded = new Promise<void>((resolve) => {
      const onLoad = (): void => {
        tilesRenderer.removeEventListener('load-root-tileset', onLoad);
        resolve();
      };
      tilesRenderer.addEventListener('load-root-tileset', onLoad);
    });

    this.scene.add(asObject3D(tilesRenderer.group));
    this.tilesRenderer = tilesRenderer;
    this.activeBackend = 'tiles';

    // Screen-space-error-driven streaming (3DTilesRendererJS's default) means this only waits
    // for the root tileset.json to parse, not the full tile tree -- exactly what "≤5s first
    // render for any model size" requires; waiting for the full tree would defeat the entire
    // point of streaming.
    await rootTilesetLoaded;

    const [metadataObjects, componentBboxes, rotationDeg] = await Promise.all([
      this.fetchTileMetadata(metadataUrl),
      this.fetchComponentBboxes(id),
      this.fetchGeorefRotationDeg(id),
    ]);
    this.tiledMetadataByFile = indexMetadataByFile(metadataObjects);
    this.tiledComponentCentroids = computeTiledCentroids(componentBboxes);

    // Georef positioning (design-checkpoint sign-off item 2): never trust mago's own
    // boundingVolume.region (garbage -- task2-findings.md, binding) -- apply this platform's
    // own resolved rotation instead, via the SAME rotation math the GLB path above uses
    // (applyGeorefRotation itself), so the two backends can never disagree on sign convention.
    //
    // Reload-race guard, mirroring the GLB branch's applyGeorefRotationIfStillCurrent above
    // (PR #14 verification's adversarial finding): the awaits feeding rotationDeg are a window
    // where a concurrent loadModel()/loadTilesModel() call could already have replaced
    // this.tilesRenderer. tilesRenderer here is a local const, so re-reading it can't
    // null-dereference the way the GLB path's `this.modelGroup` could -- but applying a
    // rotation to a now-detached instance would still be wrong (and, left unremoved by
    // unloadModel() since that only ever touches the CURRENT this.tilesRenderer, would leak
    // a stale tileset in the scene). Inlined rather than routed through
    // applyGeorefRotationIfStillCurrent since rotationDeg is already resolved (bundled into
    // the Promise.all above, not a standalone fetch) -- the check itself is the same shape,
    // just applied directly rather than wrapped around an await. Only the rotation/matrix
    // update is guarded here, matching the GLB path's own narrow scope -- the rest of this
    // function's post-await work (bbox, modelInfo, fitToModel, emit) is unguarded; see the
    // follow-up list for the real fix.
    if (this.tilesRenderer === tilesRenderer) {
      applyGeorefRotation(asObject3D(tilesRenderer.group), rotationDeg);
      asObject3D(tilesRenderer.group).updateMatrixWorld(true);
    }

    // getBoundingSphere() returns the sphere in the group's LOCAL space (3d-tiles-renderer's
    // own API doc) -- must be transformed into world space to reflect the rotation just
    // applied above, or bbox/camera-framing math would silently use the pre-rotation extent.
    const sphere = new THREE.Sphere();
    tilesRenderer.getBoundingSphere(sphere);
    sphere.applyMatrix4(asObject3D(tilesRenderer.group).matrixWorld);
    const bbox: BoundingBox = {
      min: { x: sphere.center.x - sphere.radius, y: sphere.center.y - sphere.radius, z: sphere.center.z - sphere.radius },
      max: { x: sphere.center.x + sphere.radius, y: sphere.center.y + sphere.radius, z: sphere.center.z + sphere.radius },
    };

    const modelInfo: ModelInfo = {
      id,
      name,
      format: 'tiles',
      objectCount: metadataObjects.length,
      bbox,
    };

    this.fitToModel();
    this.events.emit('modelLoaded', modelInfo);
    this.pluginHost.notifyModelLoaded(modelInfo);

    return modelInfo;
  }

  /** metadataUrl is null when the model has no metadata.json (predates Task 2, or isn't a
   * tiles-backed model at all -- loadTilesModel() only calls this on the tiles branch, but
   * metadataUrl can still be null for a tiles revision published before this field existed).
   * Same defensive-read pattern as fetchComponentBboxes below: a fetch failure degrades to
   * "no metadata", never a thrown error that would abort the whole model load. */
  private async fetchTileMetadata(metadataUrl: string | null): Promise<TileObjectMetadata[]> {
    if (!metadataUrl) return [];
    try {
      const res = await fetch(`${this.apiBaseUrl}${metadataUrl}`);
      if (!res.ok) return [];
      const doc = (await res.json()) as TileMetadataDocument;
      return doc.objects;
    } catch {
      return [];
    }
  }

  /** GET /api/models/{id}/georef -- same endpoint MapGeorefPlugin's own 2D map already uses.
   * A 404 (no georef saved for this model) resolves to rotationDeg 0, matching that plugin's
   * own catch-and-default behavior -- never a thrown error. */
  private async fetchGeorefRotationDeg(modelId: string): Promise<number> {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/models/${modelId}/georef`);
      if (!res.ok) return 0;
      const record = (await res.json()) as GeorefResponse;
      return record.rotationDeg;
    } catch {
      return 0;
    }
  }

  private async fetchComponentBboxes(modelId: string): Promise<ComponentBboxResponse[]> {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/components?model=${modelId}&fields=bbox`);
      if (!res.ok) return [];
      return (await res.json()) as ComponentBboxResponse[];
    } catch {
      return [];
    }
  }

  unloadModel(): void {
    if (this.modelGroup) {
      this.clearHighlight();
      this.clearColors();
      this.scene.remove(this.modelGroup);

      this.modelGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const material of materials) material.dispose();
        }
      });

      this.pickingProxy?.geometry.dispose();
      this.pickingProxy = null;
      this.pickingRanges = [];
      this.objectRecords.clear();
      this.tree = null;
      this.modelGroup = null;
    }

    if (this.tilesRenderer) {
      this.scene.remove(asObject3D(this.tilesRenderer.group));
      this.tilesRenderer.dispose();
      this.tilesRenderer = null;
    }
    this.activeBackend = 'glb';
    this.tiledMetadataByFile = null;
    this.tiledComponentCentroids = null;
  }

  dispose(): void {
    if (this.disposed) return;

    this.unloadModel();
    this.pluginHost.disposeAll();
    if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('click', this.handleClick);
    this.controls.dispose();
    this.dracoLoader.dispose();
    this.highlightMaterial.dispose();
    this.renderer.dispose();
    this.container.replaceChildren();

    this.disposed = true;
  }

  pick(x: number, y: number): PickResult | null {
    return this.performPick(x, y);
  }

  highlight(objectIds: string[]): void {
    this.clearHighlight();
    for (const id of objectIds) {
      const record = this.objectRecords.get(id);
      if (!record) continue;
      record.mesh.material = this.highlightMaterial;
      this.highlightedIds.add(id);
    }
  }

  clearHighlight(): void {
    for (const id of this.highlightedIds) {
      const record = this.objectRecords.get(id);
      if (record) record.mesh.material = record.originalMaterial;
    }
    this.highlightedIds.clear();
  }

  isolate(objectIds: string[]): void {
    const keep = new Set(objectIds);
    for (const [id, record] of this.objectRecords) {
      record.mesh.visible = keep.has(id);
    }
  }

  show(objectIds: string[]): void {
    for (const id of objectIds) {
      const record = this.objectRecords.get(id);
      if (record) record.mesh.visible = true;
    }
  }

  hide(objectIds: string[]): void {
    for (const id of objectIds) {
      const record = this.objectRecords.get(id);
      if (record) record.mesh.visible = false;
    }
  }

  showAll(): void {
    for (const record of this.objectRecords.values()) record.mesh.visible = true;
  }

  colorize(objectIds: string[], color: string): void {
    for (const id of objectIds) {
      const record = this.objectRecords.get(id);
      if (!record) continue;
      record.mesh.material = createColorizeMaterial(color);
      this.colorizedIds.add(id);
    }
  }

  clearColors(): void {
    for (const id of this.colorizedIds) {
      const record = this.objectRecords.get(id);
      if (record) record.mesh.material = record.originalMaterial;
    }
    this.colorizedIds.clear();
  }

  fitToModel(): void {
    if (this.activeBackend === 'tiles' && this.tilesRenderer) {
      // Box3.setFromObject(tilesRenderer.group) would only reflect whatever tiles happen to
      // be streamed in *right now*, not the model's real extent -- getBoundingSphere() reads
      // the tileset's own declared boundingVolume instead, which is stable and correct
      // regardless of what's currently loaded.
      const sphere = new THREE.Sphere();
      this.tilesRenderer.getBoundingSphere(sphere);
      // getBoundingSphere() is in the group's LOCAL space -- transform into world space so
      // the georef rotation applied in loadTilesModel() is reflected in the framed region.
      sphere.applyMatrix4(asObject3D(this.tilesRenderer.group).matrixWorld);
      this.frameBox(new THREE.Box3().setFromCenterAndSize(sphere.center, new THREE.Vector3(1, 1, 1).multiplyScalar(sphere.radius * 2)));
      return;
    }
    if (!this.modelGroup) return;
    this.frameBox(new THREE.Box3().setFromObject(this.modelGroup));
  }

  zoomToObject(objectId: string): void {
    const record = this.objectRecords.get(objectId);
    if (!record) return;
    this.frameBox(record.bbox);
  }

  /** Frames the union of the given objects' bboxes — e.g. zooming to a plugin-defined zone. */
  zoomToObjects(objectIds: string[]): void {
    let union: THREE.Box3 | null = null;
    for (const id of objectIds) {
      const record = this.objectRecords.get(id);
      if (!record) continue;
      union = union ? union.union(record.bbox) : record.bbox.clone();
    }
    if (union) this.frameBox(union);
  }

  /** World-space bbox + centroid for one object — e.g. for a plugin's zone footprint hull. */
  getObjectBounds(objectId: string): { bbox: BoundingBox; centroid: Vector3Like } | null {
    const record = this.objectRecords.get(objectId);
    if (!record) return null;
    return {
      bbox: toSharedBoundingBox(record.bbox),
      centroid: { x: record.centroid.x, y: record.centroid.y, z: record.centroid.z },
    };
  }

  /** Suspends/resumes OrbitControls — e.g. while a plugin runs its own drag gesture. */
  setOrbitEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  getModelTree(): TreeNode {
    return this.tree ?? { id: 'model', name: 'Model', children: [] };
  }

  searchObjects(substring: string): ObjectSummary[] {
    return searchSceneObjects(this.objectRecords, substring);
  }

  getObjectScreenCentroids(): Map<string, { x: number; y: number } | null> {
    const result = new Map<string, { x: number; y: number } | null>();
    const { width, height } = this.getContainerSize();

    // Tiled models: objects can span tiles that aren't currently streamed in, so their
    // centroid can't be read off any live three.js geometry the way objectRecords' centroids
    // are for the GLB path -- use the components-table bboxes fetched once at load time
    // instead (see loadTilesModel()). Zones box-select (this method's main consumer) still
    // works for objects whose tiles happen to be unloaded at the moment of selection.
    const centroidSource: Iterable<[string, THREE.Vector3]> =
      this.activeBackend === 'tiles' && this.tiledComponentCentroids
        ? this.tiledComponentCentroids
        : Array.from(this.objectRecords, ([id, record]) => [id, record.centroid] as [string, THREE.Vector3]);

    for (const [id, centroid] of centroidSource) {
      const projected = centroid.clone().project(this.camera);
      if (projected.z < -1 || projected.z > 1) {
        result.set(id, null);
        continue;
      }
      result.set(id, {
        x: (projected.x * 0.5 + 0.5) * width,
        y: (1 - (projected.y * 0.5 + 0.5)) * height,
      });
    }

    return result;
  }

  use(plugin: PlantScopePlugin): void {
    this.pluginHost.install(plugin);
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.events.on(event, handler);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.events.off(event, handler);
  }

  private frameBox(box: THREE.Box3): void {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (Math.abs(maxDim / 2 / Math.tan(fov / 2))) * 1.5;

    const direction = new THREE.Vector3(1, 0.6, 1).normalize();
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(distance / 100, 0.01);
    this.camera.far = Math.max(distance * 100, 1000);
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(center);
    this.controls.update();
  }

  private performPick(x: number, y: number): PickResult | null {
    const { width, height } = this.getContainerSize();
    const ndc = new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);

    if (this.activeBackend === 'tiles') return this.performTiledPick(x, y);
    if (!this.pickingProxy) return null;

    const hits = this.raycaster.intersectObject(this.pickingProxy, false);
    const hit = hits[0];
    if (!hit || hit.faceIndex == null) return null;

    const objectId = resolveObjectByTriangleIndex(this.pickingRanges, hit.faceIndex);
    if (!objectId) return null;

    return {
      objectId,
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      distance: hit.distance,
      screen: { x, y },
    };
  }

  /**
   * Tiled content has no single merged picking-proxy mesh with contiguous triangle-index
   * ranges the way GLB models do (the O(log n) resolveObjectByTriangleIndex() resolver
   * assumes exactly that) -- tiles stream in and out independently and mago-3d-tiler's own
   * per-tile mesh layout can't be assumed stable. Instead this raycasts directly against
   * whatever tile geometry is currently loaded (tilesRenderer.group) and resolves the hit via
   * the real per-object identity mago embeds through the standard EXT_mesh_features /
   * EXT_structural_metadata extensions (Task 3 design-checkpoint finding #1) -- NOT the hit
   * mesh's own `.name`, which real mago-3d-tiler output never sets to anything distinguishing
   * (finding #2; see resolveTiledPickMetadata()'s own doc comment in internal/tiles.ts for the
   * full feature-id -> property-table -> metadata.json walk). A hit that can't be resolved
   * this way (extensions not registered, no matching metadata.json entry) returns null rather
   * than a guessed/wrong id.
   */
  private performTiledPick(x: number, y: number): PickResult | null {
    if (!this.tilesRenderer) return null;

    const hits = this.raycaster.intersectObject(asObject3D(this.tilesRenderer.group), true);
    const hit = hits[0];
    if (!hit) return null;

    const metadata = resolveTiledPickMetadata(
      { object: hit.object, faceIndex: hit.faceIndex ?? null, point: hit.point },
      this.tiledMetadataByFile,
    );
    if (!metadata) return null;
    const objectId = tiledPickObjectId(metadata);

    return {
      objectId,
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      distance: hit.distance,
      screen: { x, y },
    };
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const result = this.performPick(event.clientX - rect.left, event.clientY - rect.top);
    if (result) {
      this.events.emit('pick', result);
      this.pluginHost.notifyPick(result);
    }
  };

  private readonly animate = (): void => {
    this.animationFrameId = requestAnimationFrame(this.animate);
    this.controls.update();
    if (this.tilesRenderer) {
      // Per USAGE.md: "The camera matrix is expected to be up to date before calling
      // tilesRenderer.update()" -- controls.update() above already refreshed the camera's
      // local transform, but world matrices only update automatically during
      // WebGLRenderer.render(); tiles' own screen-space-error calculations need it now.
      this.camera.updateMatrixWorld();
      this.tilesRenderer.update();
    }
    this.renderer.render(this.scene, this.camera);
  };

  private handleResize(): void {
    const { width, height } = this.getContainerSize();
    this.camera.aspect = width / height || 1;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    // Screen-space-error-driven LOD depends on viewport resolution -- must be refreshed on
    // resize, not just at load time.
    this.tilesRenderer?.setResolutionFromRenderer(this.camera, this.renderer);
  }

  private getContainerSize(): { width: number; height: number } {
    return {
      width: this.container.clientWidth || 800,
      height: this.container.clientHeight || 600,
    };
  }
}
