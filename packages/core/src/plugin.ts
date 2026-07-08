import type { ModelInfo, PickResult, Zone } from '@plantscope/shared';

// `import type` only — erased at compile time, so referencing Viewer here never pulls
// three.js into anything that imports from this file at runtime.
import type { Viewer } from './Viewer';

export interface RestClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
}

export interface EventBus {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

export interface ToolbarButtonSpec {
  id: string;
  label: string;
  onClick: () => void;
}

export interface PanelSpec {
  id: string;
  title: string;
  render: (container: HTMLElement) => void;
}

/** DOM-based, framework-agnostic UI slots — plugins never touch the renderer or three.js. */
export interface ToolbarSlot {
  addButton(spec: ToolbarButtonSpec): void;
  removeButton(id: string): void;
}

export interface PanelSlot {
  addPanel(spec: PanelSpec): void;
  removePanel(id: string): void;
}

export interface PluginContext {
  viewer: Viewer;
  rest: RestClient;
  events: EventBus;
  ui: {
    toolbar: ToolbarSlot;
    panel: PanelSlot;
    /**
     * The viewer's container element, for plugins that need their own pointer/drag
     * interactions over the viewport (e.g. ZonesPlugin's box-select). Never the canvas or
     * any three.js object — plain DOM, per CLAUDE.md invariant #1. Attach listeners rather
     * than replacing children; the renderer canvas and other plugins' UI slots live here too.
     */
    viewportElement: HTMLElement;
  };
}

export interface PluginHooks {
  onPick?(result: PickResult): void;
  onZoneCreated?(zone: Zone): void;
  onModelLoaded?(model: ModelInfo): void;
}

export interface PlantScopePlugin {
  id: string;
  version: string;
  onInstall(core: Viewer): void;
  onActivate(ctx: PluginContext): void;
  onDeactivate(): void;
  contributes?: {
    toolbar?: ToolbarButtonSpec[];
    panels?: PanelSpec[];
  };
  hooks?: PluginHooks;
}
