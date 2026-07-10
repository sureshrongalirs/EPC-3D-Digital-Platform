import * as Cesium from 'cesium';

import type { GeorefRecord } from '@plantscope/shared';

import { describeGeorefStatus } from './georefStatus.js';
import { createTerrainAndImageryProviders, resolveProviderConfig, type GlobeProviderConfig } from './providerConfig.js';
import { computeGlobeModelMatrix, type ModelCentroid } from './transform.js';

export interface GlobeViewOptions {
  /** Base URL prefix for REST calls (e.g. `/api/models/{id}`); defaults to '' (relative,
   * same-origin -- matches @plantscope/core's Viewer's ViewerOptions.apiUrl convention). */
  apiUrl?: string;
  providerConfig?: GlobeProviderConfig;
}

interface ModelRecordResponse {
  id: string;
  name: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  artifactUrl: string | null;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
}

export type GlobeLoadResult =
  | { kind: 'placed'; statusLabel: string; georef: GeorefRecord }
  | { kind: 'no-georef' }
  | { kind: 'not-ready'; status: 'queued' | 'processing' | 'failed' };

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
  private readonly statusEl: HTMLElement;
  private readonly providersReady: Promise<void>;
  private currentModel: Cesium.Model | null = null;

  constructor(container: string | HTMLElement, options: GlobeViewOptions = {}) {
    this.apiBaseUrl = options.apiUrl ?? '';

    const containerEl = typeof container === 'string' ? document.querySelector<HTMLElement>(container) : container;
    if (!containerEl) throw new Error(`GlobeView: no element found for container "${String(container)}"`);

    this.statusEl = document.createElement('div');
    containerEl.appendChild(this.statusEl);

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
      this.setStatus(
        `Terrain/imagery provider failed to load (${err instanceof Error ? err.message : String(err)}) -- ` +
          'the globe will render without a base map. This does not affect model placement.',
      );
    }
  }

  private setStatus(message: string): void {
    this.statusEl.textContent = message;
  }

  /**
   * Loads a model's published GLB artifact (the same artifact @plantscope/core's
   * Viewer.loadModel loads) and places it using its georef record. Never renders an
   * unsurveyed (method='assumed') placement as if it were authoritative -- see
   * describeGeorefStatus. A model with no georef yet, or that hasn't finished conversion,
   * is reported via the returned result (and this.statusEl) rather than guessing a location.
   */
  async loadModelById(modelId: string): Promise<GlobeLoadResult> {
    await this.providersReady;
    this.clearModel();

    const modelRes = await fetch(`${this.apiBaseUrl}/api/models/${modelId}`);
    if (!modelRes.ok) throw new Error(`GET /api/models/${modelId} failed: ${modelRes.status}`);
    const model = (await modelRes.json()) as ModelRecordResponse;

    if (model.status !== 'ready' || !model.artifactUrl) {
      this.setStatus(`Model "${model.name}" has no published artifact yet (status: ${model.status}).`);
      return { kind: 'not-ready', status: model.status as 'queued' | 'processing' | 'failed' };
    }

    const georefRes = await fetch(`${this.apiBaseUrl}/api/models/${modelId}/georef`);
    if (georefRes.status === 404) {
      this.setStatus(
        `Model "${model.name}" has no georeference set yet -- plot it in the Map/Georeference ` +
          'view first. Not rendering it at an arbitrary location.',
      );
      return { kind: 'no-georef' };
    }
    if (!georefRes.ok) throw new Error(`GET /api/models/${modelId}/georef failed: ${georefRes.status}`);
    const georef = (await georefRes.json()) as GeorefRecord;

    const centroid = computeCentroid(model.bboxMin, model.bboxMax);
    const modelMatrix = computeGlobeModelMatrix(georef, centroid);

    const artifactUrl = `${this.apiBaseUrl}${model.artifactUrl}`;
    const cesiumModel = await Cesium.Model.fromGltfAsync({ url: artifactUrl, modelMatrix });
    this.viewer.scene.primitives.add(cesiumModel);
    this.currentModel = cesiumModel;

    // fromGltfAsync's promise resolves once the Model object exists, NOT once it's ready
    // to render -- `ready`/`boundingSphere` etc. only become valid on a later render-loop
    // tick, after the primitive above has actually been drawn at least once. Reading
    // boundingSphere before that throws "The model is not loaded. Use Model.readyEvent or
    // wait for Model.ready to be true." (this was happening on every load, logged
    // repeatedly). Must wait for readyEvent -- but also handle the (real, documented)
    // possibility that ready is already true by the time we get here, since readyEvent
    // only fires once and we'd otherwise hang forever waiting for an event that already
    // happened.
    await this.waitUntilModelReady(cesiumModel);

    const statusLabel = describeGeorefStatus(georef);
    this.setStatus(`"${model.name}": ${statusLabel}`);

    this.viewer.camera.flyToBoundingSphere(cesiumModel.boundingSphere, { duration: 1.5 });

    return { kind: 'placed', statusLabel, georef };
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

  private clearModel(): void {
    if (this.currentModel) {
      this.viewer.scene.primitives.remove(this.currentModel);
      this.currentModel = null;
    }
  }

  destroy(): void {
    this.clearModel();
    this.viewer.destroy();
  }
}
