import { computeConvexHull2D, type BoundingBox, type Point2D } from '@plantscope/shared';

export interface ZoneBoundary {
  footprint: Point2D[];
  zmin: number;
  zmax: number;
}

/**
 * Derives a zone's boundary (layer 2 of the definition/boundary/members model) from its
 * resolved members' world bboxes (layer 3): a 2D convex hull over all 4 X/Z corners of
 * every member's bbox, plus the vertical (world Y) range spanning them all.
 */
export function computeZoneBoundary(bboxes: readonly BoundingBox[]): ZoneBoundary {
  if (bboxes.length === 0) {
    return { footprint: [], zmin: 0, zmax: 0 };
  }

  const corners: Point2D[] = [];
  let zmin = Infinity;
  let zmax = -Infinity;

  for (const box of bboxes) {
    corners.push(
      { x: box.min.x, y: box.min.z },
      { x: box.min.x, y: box.max.z },
      { x: box.max.x, y: box.min.z },
      { x: box.max.x, y: box.max.z },
    );
    zmin = Math.min(zmin, box.min.y);
    zmax = Math.max(zmax, box.max.y);
  }

  return { footprint: computeConvexHull2D(corners), zmin, zmax };
}
