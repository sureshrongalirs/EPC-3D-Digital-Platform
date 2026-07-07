/** Pure, headless-testable box-select logic — no DOM, no @plantscope/core. */
export interface ScreenRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Every object whose screen centroid falls inside `rect` (inclusive), given the
 * `viewer.getObjectScreenCentroids()` map. Centroids that are `null` (behind the camera,
 * per Viewer's convention) are never selected. `rect` may be given in either corner order.
 */
export function selectObjectsInRect(
  centroids: ReadonlyMap<string, { x: number; y: number } | null>,
  rect: ScreenRect,
): string[] {
  const minX = Math.min(rect.x1, rect.x2);
  const maxX = Math.max(rect.x1, rect.x2);
  const minY = Math.min(rect.y1, rect.y2);
  const maxY = Math.max(rect.y1, rect.y2);

  const selected: string[] = [];
  for (const [id, point] of centroids) {
    if (!point) continue;
    if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) {
      selected.push(id);
    }
  }
  return selected;
}
