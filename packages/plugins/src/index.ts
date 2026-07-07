// NOTE: plugins must never import three.js or touch the renderer directly (see CLAUDE.md).
// This package only depends on @plantscope/core's facade.
export function getPluginsPlaceholder(): string {
  return 'PlantScope plugins placeholder';
}
