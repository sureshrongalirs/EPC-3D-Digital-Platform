// NOTE: this package's public API must never expose three.js types (see CLAUDE.md).
// Plugins consume only the CoreSDK facade + PluginContext defined here.
export function getCorePlaceholder(): string {
  return 'PlantScope core placeholder';
}
