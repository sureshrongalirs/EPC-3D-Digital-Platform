import type { BoundingBox, ModelInfo, ObjectSummary, PickResult, TreeNode } from '@plantscope/shared';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { createPanelSlot, createToolbarSlot } from './internal/domSlots';
import { EventBusImpl } from './internal/eventBus';
import { createColorizeMaterial, createHighlightMaterial } from './internal/highlight';
import { resolveObjectByTriangleIndex } from './internal/picking';
import { PluginHost } from './internal/pluginHost';
import { RestClientImpl } from './internal/restClient';
import { buildSceneRegistry, searchSceneObjects, type SceneObjectRecord } from './internal/sceneRegistry';
import type { PickRange } from './internal/picking';
import type { PlantScopePlugin } from './plugin';

export interface ViewerOptions {
  apiUrl?: string;
}

interface ObjectRecord extends SceneObjectRecord {
  originalMaterial: THREE.Material | THREE.Material[];
}

// DRACOLoader decoder assets are local, static files (see CLAUDE.md: no CDN at runtime).
// The host app is responsible for serving three's examples/jsm/libs/draco/ contents at
// this path — apps/demo does so from public/draco/.
const DRACO_DECODER_PATH = '/draco/';

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
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
  private readonly restClient: RestClientImpl;
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
    this.restClient = new RestClientImpl(opts.apiUrl ?? '');
    this.events = new EventBusImpl();
    this.pluginHost = new PluginHost(
      this,
      this.restClient,
      this.events,
      createToolbarSlot(this.container),
      createPanelSlot(this.container),
    );

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);
    this.renderer.domElement.addEventListener('click', this.handleClick);

    this.animate();
  }

  async loadModel(source: string | ArrayBuffer | ModelInfo): Promise<ModelInfo> {
    this.unloadModel();

    let arrayBuffer: ArrayBuffer;
    let id: string;
    let name: string;

    if (typeof source === 'string') {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Failed to fetch model "${source}": ${res.status}`);
      arrayBuffer = await res.arrayBuffer();
      id = generateId();
      name = source.split('/').pop() || 'model';
    } else if (source instanceof ArrayBuffer) {
      arrayBuffer = source;
      id = generateId();
      name = 'model';
    } else {
      const url = `${this.restClient.baseUrl}/models/${source.id}/binary`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch model "${source.id}": ${res.status}`);
      arrayBuffer = await res.arrayBuffer();
      id = source.id;
      name = source.name;
    }

    const gltf = await this.gltfLoader.parseAsync(arrayBuffer, '');
    this.modelGroup = gltf.scene;
    this.scene.add(this.modelGroup);

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
      format: 'glb',
      objectCount: this.objectRecords.size,
      bbox: toSharedBoundingBox(bbox),
    };

    this.fitToModel();
    this.events.emit('modelLoaded', modelInfo);
    this.pluginHost.notifyModelLoaded(modelInfo);

    return modelInfo;
  }

  unloadModel(): void {
    if (!this.modelGroup) return;

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
    if (!this.modelGroup) return;
    this.frameBox(new THREE.Box3().setFromObject(this.modelGroup));
  }

  zoomToObject(objectId: string): void {
    const record = this.objectRecords.get(objectId);
    if (!record) return;
    this.frameBox(record.bbox);
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

    for (const [id, record] of this.objectRecords) {
      const projected = record.centroid.clone().project(this.camera);
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
    if (!this.pickingProxy) return null;

    const { width, height } = this.getContainerSize();
    const ndc = new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);

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
    this.renderer.render(this.scene, this.camera);
  };

  private handleResize(): void {
    const { width, height } = this.getContainerSize();
    this.camera.aspect = width / height || 1;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private getContainerSize(): { width: number; height: number } {
    return {
      width: this.container.clientWidth || 800,
      height: this.container.clientHeight || 600,
    };
  }
}
