import * as Cesium from 'cesium';

import type { GeorefRecord } from '@plantscope/shared';

import { describeGeorefStatus } from './georefStatus.js';
import { parseGlbNodeNames } from './glbNodeNames.js';
import { createTerrainAndImageryProviders, resolveProviderConfig, type GlobeProviderConfig } from './providerConfig.js';
import { computeGlobeModelMatrix, type GlobeTransformInput, type ModelCentroid } from './transform.js';

export interface GlobeViewOptions {
  /** Base URL prefix for REST calls (e.g. `/api/models/{id}`); defaults to '' (relative,
   * same-origin -- matches @plantscope/core's Viewer's ViewerOptions.apiUrl convention). */
  apiUrl?: string;
  providerConfig?: GlobeProviderConfig;
  /** Forwards progress/placement/error messages -- wire this to your own log UI. */
  onStatus?: (message: string) => void;
  /** Fires only on an actual hit (matches @plantscope/core's Viewer's 'pick' event, which
   * likewise never fires for a click on empty space). */
  onPick?: (picked: PickedNodeInfo) => void;
}

export interface PickedNodeInfo {
  nodeName: string;
  /** Engineering properties for this node, resolved by treating the node name as a Linkage
   * key (the same simplification ZonesPlugin already documents using -- see CLAUDE.md
   * invariant #3's note on real Linkage-key recovery being a Phase 4 worker feature). null
   * if GET /api/components/{nodeName}?model={id} found nothing, which is expected for most
   * nodes unless the model went through the worker's real FBX/mdb2 join. */
  componentProps: Record<string, unknown> | null;
}

interface ModelRecordResponse {
  id: string;
  name: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  artifactUrl: string | null;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
}

interface ComponentResponse {
  props: Record<string, unknown> | null;
}

export type GlobeLoadResult =
  | { kind: 'placed'; statusLabel: string; georef: GeorefRecord | null }
  | { kind: 'not-ready'; status: 'queued' | 'processing' | 'failed' };

/** Hyderabad, Telangana, India -- used only when a model has no georef record at all, so
 * there is still somewhere sensible to show it rather than nowhere. Always clearly labeled
 * as a default (see DEFAULT_FALLBACK_LABEL below), never presented as if it were a real,
 * surveyed placement -- same principle as describeGeorefStatus's method='assumed' handling. */
export const DEFAULT_FALLBACK_ANCHOR: GlobeTransformInput = {
  anchorLat: 17.385044,
  anchorLon: 78.486671,
  height: 520.35,
  rotationDeg: 0,
  anchorConvention: 'model_origin',
};
const DEFAULT_FALLBACK_LABEL = 'default location -- no LLH file provided';

interface CesiumPickResult {
  detail?: { node?: { name?: string } };
}

function computeCentroid(bboxMin: [number, number, number] | null, bboxMax: [number, number, number] | null): ModelCentroid | undefined {
  if (!bboxMin || !bboxMax) return undefined;
  return {
    x: (bboxMin[0] + bboxMax[0]) / 2,
    y: (bboxMin[1] + bboxMax[1]) / 2,
    z: (bboxMin[2] + bboxMax[2]) / 2,
  };
}

/**
 * A sibling rendering surface to @plantscope/core's three.js Viewer, not a plugin -- see
 * CLAUDE.md's "Rendering surfaces" note. Owns its own Cesium.Viewer (own canvas, own WebGL
 * context) and reads the same catalog/georef REST API @plantscope/core and MapGeorefPlugin
 * already use; the only thing it shares with the three.js side is that data, never code.
 */
export class GlobeView {
  private readonly viewer: Cesium.Viewer;
  private readonly apiBaseUrl: string;
  private readonly providersReady: Promise<void>;
  private readonly onStatus: (message: string) => void;
  private readonly onPick: ((picked: PickedNodeInfo) => void) | undefined;
  private currentModel: Cesium.Model | null = null;
  private currentModelId: string | null = null;
  private currentNodeNames: string[] = [];

  constructor(container: string | HTMLElement, options: GlobeViewOptions = {}) {
    this.apiBaseUrl = options.apiUrl ?? '';
    this.onStatus = options.onStatus ?? ((): void => {});
    this.onPick = options.onPick;

    const containerEl = typeof container === 'string' ? document.querySelector<HTMLElement>(container) : container;
    if (!containerEl) throw new Error(`GlobeView: no element found for container "${String(container)}"`);

    // Constructing Cesium.Viewer inside a hidden (display:none) element gives it a 0x0
    // canvas that doesn't recover correctly even once later shown -- this was a real bug
    // (see this package's git history). Callers must construct GlobeView only once its
    // container is visible and already has real pixel dimensions; logged (not just
    // asserted) so this is diagnosable from the browser console if it ever regresses.
    console.log(`GlobeView: container dimensions at construction: ${containerEl.offsetWidth}x${containerEl.offsetHeight}`);
    if (containerEl.offsetWidth === 0 || containerEl.offsetHeight === 0) {
      console.warn(
        'GlobeView: container has zero width or height at construction time -- Cesium will not size ' +
          'correctly. Construct GlobeView only after its container is visible and sized.',
      );
    }

    const cesiumEl = document.createElement('div');
    Object.assign(cesiumEl.style, { width: '100%', height: '100%' });
    containerEl.appendChild(cesiumEl);

    this.viewer = new Cesium.Viewer(cesiumEl, {
      baseLayerPicker: false,
      animation: false,
      timeline: false,
      geocoder: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      homeButton: true,
    });

    this.providersReady = this.setupProviders(options.providerConfig ?? {});
    this.setupPicking();
  }

  private setupPicking(): void {
    this.viewer.screenSpaceEventHandler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      void this.handleClick(event.position);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  private async handleClick(position: Cesium.Cartesian2): Promise<void> {
    if (!this.currentModel || !this.onPick) return;

    const picked = this.viewer.scene.pick(position) as CesiumPickResult | undefined;
    const nodeName = picked?.detail?.node?.name;
    if (!nodeName) return; // clicked empty space, or a node picking can't name

    let componentProps: Record<string, unknown> | null = null;
    if (this.currentModelId) {
      try {
        const res = await fetch(`${this.apiBaseUrl}/api/components/${encodeURIComponent(nodeName)}?model=${this.currentModelId}`);
        if (res.ok) componentProps = ((await res.json()) as ComponentResponse).props;
      } catch {
        // Component lookup failing is not fatal to picking -- report no properties instead.
      }
    }

    this.onPick({ nodeName, componentProps });
  }

  private async setupProviders(overrides: GlobeProviderConfig): Promise<void> {
    const resolved = resolveProviderConfig(overrides);
    try {
      const { terrainProvider, imageryProvider } = await createTerrainAndImageryProviders(resolved);
      this.viewer.terrainProvider = terrainProvider;
      this.viewer.imageryLayers.removeAll();
      this.viewer.imageryLayers.add(new Cesium.ImageryLayer(imageryProvider));
    } catch (err) {
      // Ion auth/network failure fails per-tile, not the whole Viewer (see
      // providerConfig.ts's doc comment) -- the globe still renders (just without a base
      // map/terrain), and a model can still be loaded and placed on the bare ellipsoid.
      this.onStatus(
        `Terrain/imagery provider failed to load (${err instanceof Error ? err.message : String(err)}) -- ` +
          'the globe will render without a base map. This does not affect model placement.',
      );
    }
  }

  /**
   * Loads a model's published GLB artifact (the same artifact @plantscope/core's
   * Viewer.loadModel loads) and places it using its georef record if one exists, or
   * DEFAULT_FALLBACK_ANCHOR (clearly labeled) if not -- a ready model is always shown
   * somewhere once it's ready, never left unplaced just because no LLH/georef was provided.
   */
  async loadModelById(modelId: string): Promise<GlobeLoadResult> {
    await this.providersReady;
    this.clearModel();
    this.currentModelId = modelId;

    const modelRes = await fetch(`${this.apiBaseUrl}/api/models/${modelId}`);
    if (!modelRes.ok) throw new Error(`GET /api/models/${modelId} failed: ${modelRes.status}`);
    const model = (await modelRes.json()) as ModelRecordResponse;

    if (model.status !== 'ready' || !model.artifactUrl) {
      this.onStatus(`Model "${model.name}" has no published artifact yet (status: ${model.status}).`);
      return { kind: 'not-ready', status: model.status as 'queued' | 'processing' | 'failed' };
    }

    const georefRes = await fetch(`${this.apiBaseUrl}/api/models/${modelId}/georef`);
    let georef: GeorefRecord | null = null;
    let statusLabel: string;
    if (georefRes.status === 404) {
      statusLabel = DEFAULT_FALLBACK_LABEL;
    } else if (!georefRes.ok) {
      throw new Error(`GET /api/models/${modelId}/georef failed: ${georefRes.status}`);
    } else {
      georef = (await georefRes.json()) as GeorefRecord;
      statusLabel = describeGeorefStatus(georef);
    }

    const centroid = computeCentroid(model.bboxMin, model.bboxMax);
    const modelMatrix = computeGlobeModelMatrix(georef ?? DEFAULT_FALLBACK_ANCHOR, centroid);

    const artifactUrl = `${this.apiBaseUrl}${model.artifactUrl}`;
    const buffer = await (await fetch(artifactUrl)).arrayBuffer();
    await this.placeModelFromBytes(buffer, modelMatrix);

    this.onStatus(`"${model.name}": ${statusLabel}`);
    return { kind: 'placed', statusLabel, georef };
  }

  /**
   * Loads a local .glb file directly (no server round-trip, no catalog id, no component
   * lookups on pick). There is no georef possible for an arbitrary local file, so it always
   * uses the default fallback location, labeled the same way as a server-backed model with
   * no georef.
   */
  async loadLocalFile(file: File): Promise<void> {
    await this.providersReady;
    this.clearModel();
    this.currentModelId = null;

    const buffer = await file.arrayBuffer();
    const modelMatrix = computeGlobeModelMatrix(DEFAULT_FALLBACK_ANCHOR);
    await this.placeModelFromBytes(buffer, modelMatrix);
    this.onStatus(`"${file.name}": ${DEFAULT_FALLBACK_LABEL} (local preview)`);
  }

  private async placeModelFromBytes(buffer: ArrayBuffer, modelMatrix: Cesium.Matrix4): Promise<void> {
    this.currentNodeNames = parseGlbNodeNames(buffer);

    const blobUrl = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
    try {
      const cesiumModel = await Cesium.Model.fromGltfAsync({ url: blobUrl, modelMatrix });
      this.viewer.scene.primitives.add(cesiumModel);
      this.currentModel = cesiumModel;

      // fromGltfAsync's promise resolves once the Model object is constructed, NOT once
      // it's ready to render -- boundingSphere etc. only become valid on a later
      // render-loop tick. Must wait for readyEvent (or ready already being true).
      await this.waitUntilModelReady(cesiumModel);
      this.viewer.camera.flyToBoundingSphere(cesiumModel.boundingSphere, { duration: 1.5 });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  private waitUntilModelReady(model: Cesium.Model): Promise<void> {
    if (model.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const removeListener = model.readyEvent.addEventListener(() => {
        removeListener();
        resolve();
      });
    });
  }

  /** Re-flies the camera to the currently loaded model, if any. */
  fitToModel(): void {
    if (this.currentModel) {
      this.viewer.camera.flyToBoundingSphere(this.currentModel.boundingSphere, { duration: 1.0 });
    }
  }

  /**
   * Hides every named node of the current model except `nodeName`. Requires the node names
   * parsed from the GLB's own JSON chunk at load time (see glbNodeNames.ts) -- Cesium.Model
   * has no public API to enumerate a model's nodes, only to look one up by name once you
   * already know it.
   */
  isolate(nodeName: string): void {
    if (!this.currentModel) return;
    for (const name of this.currentNodeNames) {
      const node = this.currentModel.getNode(name);
      if (node) node.show = name === nodeName;
    }
  }

  showAll(): void {
    if (!this.currentModel) return;
    for (const name of this.currentNodeNames) {
      const node = this.currentModel.getNode(name);
      if (node) node.show = true;
    }
  }

  private clearModel(): void {
    if (this.currentModel) {
      this.viewer.scene.primitives.remove(this.currentModel);
      this.currentModel = null;
      this.currentNodeNames = [];
    }
  }

  destroy(): void {
    this.clearModel();
    this.viewer.destroy();
  }
}
