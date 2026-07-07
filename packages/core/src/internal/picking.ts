/**
 * Pure O(log n) resolver: GPU raycast returns a global triangle index into the merged
 * "picking proxy" geometry; this maps that index back to the owning object. No three.js
 * or DOM dependency — kept headless-testable per CLAUDE.md's picking design.
 */
export interface PickRange {
  /** Inclusive start triangle index. */
  start: number;
  /** Exclusive end triangle index. */
  end: number;
  objectId: string;
}

/**
 * `ranges` must be sorted by `start` and non-overlapping (as produced by
 * {@link buildSceneRegistry}, which assigns contiguous ranges in traversal order).
 */
export function resolveObjectByTriangleIndex(
  ranges: readonly PickRange[],
  triangleIndex: number,
): string | null {
  let lo = 0;
  let hi = ranges.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = ranges[mid];
    if (range === undefined) break;

    if (triangleIndex < range.start) {
      hi = mid - 1;
    } else if (triangleIndex >= range.end) {
      lo = mid + 1;
    } else {
      return range.objectId;
    }
  }

  return null;
}
