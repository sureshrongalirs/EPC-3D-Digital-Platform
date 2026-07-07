import { describe, expect, it } from 'vitest';

import {
  boundingBoxCenter,
  computeConvexHull2D,
  createEmptyBoundingBox,
  expandBoundingBox,
  findBestTrigramMatch,
  latLonToLocal,
  localToLatLon,
  mergeBoundingBoxes,
  polygonArea,
  trigramSimilarity,
  type Point2D,
} from './index';

describe('bounding box helpers', () => {
  it('creates an empty box that is inverted (min > max)', () => {
    const box = createEmptyBoundingBox();
    expect(box.min.x).toBeGreaterThan(box.max.x);
  });

  it('expands to include a point', () => {
    const box = expandBoundingBox(createEmptyBoundingBox(), { x: 1, y: -2, z: 3 });
    expect(box.min).toEqual({ x: 1, y: -2, z: 3 });
    expect(box.max).toEqual({ x: 1, y: -2, z: 3 });
  });

  it('merges two boxes into their union', () => {
    const a = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
    const b = { min: { x: -1, y: 2, z: 0.5 }, max: { x: 0.5, y: 3, z: 2 } };
    expect(mergeBoundingBoxes(a, b)).toEqual({
      min: { x: -1, y: 0, z: 0 },
      max: { x: 1, y: 3, z: 2 },
    });
  });

  it('computes the center of a box', () => {
    const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 4, z: 6 } };
    expect(boundingBoxCenter(box)).toEqual({ x: 1, y: 2, z: 3 });
  });
});

function sortPoints(points: readonly Point2D[]): Point2D[] {
  return [...points].sort((a, b) => a.x - b.x || a.y - b.y);
}

describe('computeConvexHull2D', () => {
  it('returns the 4 corners of a square, dropping an interior point', () => {
    const square: Point2D[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 }, // interior — must not appear in the hull
    ];
    const hull = computeConvexHull2D(square);
    expect(sortPoints(hull)).toEqual(
      sortPoints([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ]),
    );
  });

  it('drops collinear points on an edge', () => {
    const points: Point2D[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 }, // collinear midpoint on the bottom edge
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const hull = computeConvexHull2D(points);
    expect(hull.some((p) => p.x === 5 && p.y === 0)).toBe(false);
    expect(hull).toHaveLength(4);
  });

  it('produces a hull whose bounding-box extent matches the input extent', () => {
    const points: Point2D[] = [
      { x: -3, y: 7 },
      { x: 8, y: -2 },
      { x: 2, y: 2 },
      { x: -1, y: -5 },
      { x: 4, y: 9 },
      { x: 0, y: 0 },
      { x: -3, y: -5 },
      { x: 8, y: 9 },
    ];
    const hull = computeConvexHull2D(points);

    const extent = (pts: readonly Point2D[]) => ({
      minX: Math.min(...pts.map((p) => p.x)),
      maxX: Math.max(...pts.map((p) => p.x)),
      minY: Math.min(...pts.map((p) => p.y)),
      maxY: Math.max(...pts.map((p) => p.y)),
    });

    expect(extent(hull)).toEqual(extent(points));
  });

  it('handles degenerate inputs (0, 1, 2 points) without throwing', () => {
    expect(computeConvexHull2D([])).toEqual([]);
    expect(computeConvexHull2D([{ x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }]);
    expect(computeConvexHull2D([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toHaveLength(2);
  });
});

describe('georef round-trip (localToLatLon <-> latLonToLocal)', () => {
  const anchor = { lat: 29.4749, lon: 76.8909 };

  it('reprojecting a rotated footprint back to local meters preserves its area', () => {
    const footprint: Point2D[] = [
      { x: -12.5, y: -8 },
      { x: 12.5, y: -8 },
      { x: 12.5, y: 8 },
      { x: -12.5, y: 8 },
    ];
    const rotationDeg = 37;
    const originalArea = polygonArea(footprint);

    const latLonPoints = footprint.map((p) => localToLatLon(p, anchor, rotationDeg));
    const roundTripped = latLonPoints.map((ll) => latLonToLocal(ll, anchor, rotationDeg));
    const roundTrippedArea = polygonArea(roundTripped);

    expect(roundTrippedArea).toBeCloseTo(originalArea, 4);
    for (let i = 0; i < footprint.length; i += 1) {
      expect(roundTripped[i]!.x).toBeCloseTo(footprint[i]!.x, 6);
      expect(roundTripped[i]!.y).toBeCloseTo(footprint[i]!.y, 6);
    }
  });

  it('places a point due north of the anchor at rotationDeg 0', () => {
    const result = localToLatLon({ x: 0, y: 100 }, anchor, 0);
    expect(result.lat).toBeGreaterThan(anchor.lat);
    expect(result.lon).toBeCloseTo(anchor.lon, 9);
  });

  it('the anchor itself round-trips to local (0, 0)', () => {
    const local = latLonToLocal(anchor, anchor, 90);
    expect(local.x).toBeCloseTo(0, 9);
    expect(local.y).toBeCloseTo(0, 9);
  });
});

describe('trigramSimilarity / findBestTrigramMatch', () => {
  it('scores an exact match as 1', () => {
    expect(trigramSimilarity('Pump-2', 'Pump-2')).toBe(1);
  });

  it('scores a near-miss (same tag, different casing/format) highly', () => {
    const score = trigramSimilarity('Pump-2', 'PUMP-002');
    expect(score).toBeGreaterThan(0.4);
  });

  it('scores unrelated strings low', () => {
    const score = trigramSimilarity('Pump-2', 'Structural Beam West');
    expect(score).toBeLessThan(0.2);
  });

  it('findBestTrigramMatch returns the highest-scoring candidate above threshold', () => {
    const candidates = ['PUMP-001', 'PUMP-002', 'VALVE-014'];
    const match = findBestTrigramMatch('Pump-2', candidates, (c) => c, 0.3);
    expect(match?.candidate).toBe('PUMP-002');
  });

  it('findBestTrigramMatch returns null when nothing clears the threshold', () => {
    const candidates = ['VALVE-014', 'STRUCTURAL-BEAM-9'];
    const match = findBestTrigramMatch('Pump-2', candidates, (c) => c, 0.3);
    expect(match).toBeNull();
  });
});
