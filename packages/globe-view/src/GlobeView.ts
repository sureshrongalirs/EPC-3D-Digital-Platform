import * as Cesium from 'cesium';

import type { GeorefRecord } from '@plantscope/shared';

import { describeGeorefStatus } from './georefStatus.js';
import { parseGlbNodeNames } from './glbNodeNames.js';
import { createTerrainAndImageryProviders, resolveProviderConfig, type GlobeProviderConfig } from './providerConfig.js';
import { computeGlobeModelMatrix, type ModelCentroid } from './transform.js';

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
  | { kind: 'placed'; statusLabel: string; georef: GeorefRecord }
  | { kind: 'no-location' }
  | { kind: 'not-ready'; status: 'queued' | 'processing' | 'failed' };

/** Shown (via onStatus) whenever a model has no georef record -- no LLH file was uploaded
 * with it, and nothing has been saved via the Map/Georeference view either. There is no
 * fallback location: an earlier version of this placed such a model at a fixed
 * (Hyderabad) coordinate, which was just a placeholder and not a real position for any
 * given model -- silently rendering it there would misrepresent an unplaced model as a
 * real, surveyed one. Camera flies home to the whole-Earth view instead (see flyHome() in
 * loadModelById/loadLocalFile below) so there's at least something meaningful on screen. */
const NO_LOCATION_MESSAGE = 'No location set -- upload an LLH file with your FBX to place this model on the globe.';

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
   * Viewer.loadModel loads) and places it using its georef record. If the model has no
   * georef (no LLH file uploaded and nothing saved via Map/Georeference), it is never placed
   * at a fake location -- see NO_LOCATION_MESSAGE.
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
    if (georefRes.status === 404) {
      this.onStatus(`"${model.name}": ${NO_LOCATION_MESSAGE}`);
      this.viewer.camera.flyHome(1.5);
      return { kind: 'no-location' };
    }
    if (!georefRes.ok) throw new Error(`GET /api/models/${modelId}/georef failed: ${georefRes.status}`);
    const georef = (await georefRes.json()) as GeorefRecord;
    const statusLabel = describeGeorefStatus(georef);

    const centroid = computeCentroid(model.bboxMin, model.bboxMax);
    const modelMatrix = computeGlobeModelMatrix(georef, centroid);

    const artifactUrl = `${this.apiBaseUrl}${model.artifactUrl}`;
    const buffer = await (await fetch(artifactUrl)).arrayBuffer();
    await this.placeModelFromBytes(buffer, modelMatrix);

    this.onStatus(`"${model.name}": ${statusLabel}`);
    return { kind: 'placed', statusLabel, georef };
  }

  /**
   * Loads a local .glb file directly (no server round-trip, no catalog id, no component
   * lookups on pick). A local file has no possible georef -- there is nowhere real to place
   * it, and (per this package's policy of never rendering a model at a fake location) it is
   * not rendered on the globe at all; this just reports NO_LOCATION_MESSAGE and shows the
   * whole-Earth view, same as a server-backed model with no georef.
   */
  async loadLocalFile(file: File): Promise<void> {
    await this.providersReady;
    this.clearModel();
    this.currentModelId = null;

    this.onStatus(`"${file.name}": ${NO_LOCATION_MESSAGE}`);
    this.viewer.camera.flyHome(1.5);
  }

  private async placeModelFromBytes(buffer: ArrayBuffer, modelMatrix: Cesium.Matrix4): Promise<void> {
    this.currentNodeNames = parseGlbNodeNames(buffer);

    const blobUrl = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
    try {
      // minimumPixelSize (default 0) and maximumScale (default uncapped) already do NOT
      // artificially shrink/grow a model based on camera distance unless explicitly
      // configured to -- neither was set here, so LOD-driven scaling was checked and ruled
      // out as a cause of the "model disappears when zooming in" bug (that turned out to be
      // terrain occlusion -- see heightReference below). minimumPixelSize is still passed
      // explicitly (rather than left implicit) so this is verifiable at a glance rather
      // than relying on Cesium's default matching what we want.
      //
      // heightReference/scene: a model placed at a fixed height (from a georef's raw
      // height, frequently 0 or otherwise uncalibrated against Cesium World Terrain's
      // actual elevation -- CLAUDE.md never assumes a height datum is meaningful) sinks
      // underground the moment high-detail terrain streams in at close zoom, since that
      // terrain doesn't match the fixed height at all. A one-time sampleTerrainMostDetailed()
      // call (this package's earlier approach) wasn't reliable enough -- it only samples
      // whatever terrain LOD is available *at that moment*, not whatever loads in later as
      // the camera moves. CLAMP_TO_GROUND instead has Cesium re-clamp the model to the
      // terrain surface every frame, automatically tracking terrain as it streams in at
      // higher detail, so the model is never underground regardless of zoom level. `scene`
      // must be supplied for `heightReference` to take effect at all (undocumented
      // requirement, easy to miss: Cesium's own JSDoc for Model.fromGltfAsync notes this).
      const cesiumModel = await Cesium.Model.fromGltfAsync({
        url: blobUrl,
        modelMatrix,
        minimumPixelSize: 0,
        scene: this.viewer.scene,
      });
      cesiumModel.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;

      this.viewer.scene.primitives.add(cesiumModel);
      this.currentModel = cesiumModel;

      // fromGltfAsync's promise resolves once the Model object is constructed, NOT once
      // it's ready to render -- boundingSphere etc. only become valid on a later
      // render-loop tick. Must wait for readyEvent (or ready already being true).
      await this.waitUntilModelReady(cesiumModel);

      // Logged so an unexpectedly tiny/huge radius (a scale bug) is visible without
      // needing to reproduce visually -- see this task's "model disappears when zooming in"
      // investigation, point (b).
      console.log(`GlobeView: model boundingSphere radius = ${cesiumModel.boundingSphere.radius}m`);

      // A wide offset (3x the model's own radius back and slightly above) gives a good
      // viewing angle directly above/around the model rather than flying in so close the
      // model fills (or exceeds) the whole viewport.
      this.viewer.camera.flyToBoundingSphere(cesiumModel.boundingSphere, {
        duration: 2,
        offset: new Cesium.HeadingPitchRange(0, -0.5, cesiumModel.boundingSphere.radius * 3),
      });
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
