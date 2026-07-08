// Public API surface of @plantscope/core. The underlying rendering engine is an internal
// implementation detail and must never appear here — see CLAUDE.md invariant #1 and
// internal/apiSurface.test.ts, which scans the built .d.ts to enforce this.
export { Viewer } from './Viewer';
export type { ModelPointer, ViewerOptions } from './Viewer';
export type {
  EventBus,
  PanelSlot,
  PanelSpec,
  PlantScopePlugin,
  PluginContext,
  PluginHooks,
  RestClient,
  ToolbarButtonSpec,
  ToolbarSlot,
} from './plugin';
export type {
  BoundingBox,
  GeorefMethod,
  GeorefRecord,
  HeightDatum,
  ModelInfo,
  ObjectSummary,
  PickResult,
  RotationSource,
  ScreenPoint,
  TreeNode,
  Vector3Like,
  Zone,
} from '@plantscope/shared';
