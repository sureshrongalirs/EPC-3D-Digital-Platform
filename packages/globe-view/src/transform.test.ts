import * as Cesium from 'cesium';
import { describe, expect, it } from 'vitest';

import { computeGlobeModelMatrix, type GlobeTransformInput } from './transform.js';

// Panipat Refinery test-default anchor (see packages/plugins' MapGeorefPlugin.ts
// DEFAULT_ANCHOR) -- reused here purely as a realistic, non-null-island coordinate.
const ANCHOR_LAT = 29.4749;
const ANCHOR_LON = 76.8909;

function baseInput(overrides: Partial<GlobeTransformInput> = {}): GlobeTransformInput {
  return {
    anchorLat: ANCHOR_LAT,
    anchorLon: ANCHOR_LON,
    height: 220,
    rotationDeg: 0,
    anchorConvention: 'model_origin',
    ...overrides,
  };
}

function expectCartesianClose(actual: Cesium.Cartesian3, expected: Cesium.Cartesian3, epsilonMeters = 1e-6): void {
  expect(Cesium.Cartesian3.equalsEpsilon(actual, expected, 0, epsilonMeters)).toBe(true);
}

describe('computeGlobeModelMatrix', () => {
  it('places the local origin exactly at the ECEF position of the anchor lat/lon/height (model_origin)', () => {
    const input = baseInput({ anchorConvention: 'model_origin' });
    const matrix = computeGlobeModelMatrix(input);

    const localOrigin = new Cesium.Cartesian3(0, 0, 0);
    const placed = Cesium.Matrix4.multiplyByPoint(matrix, localOrigin, new Cesium.Cartesian3());

    const expected = Cesium.Cartesian3.fromDegrees(input.anchorLon, input.anchorLat, input.height ?? 0);
    expectCartesianClose(placed, expected);
  });

  it('treats a null height as 0 rather than throwing or producing NaN', () => {
    const input = baseInput({ height: null });
    const matrix = computeGlobeModelMatrix(input);
    const placed = Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(0, 0, 0), new Cesium.Cartesian3());

    const expected = Cesium.Cartesian3.fromDegrees(input.anchorLon, input.anchorLat, 0);
    expectCartesianClose(placed, expected);
  });

  it('places the model centroid (not local origin) at the anchor when anchorConvention is model_centroid', () => {
    const input = baseInput({ anchorConvention: 'model_centroid' });
    const centroid = { x: 12.5, y: 3, z: -7.25 };
    const matrix = computeGlobeModelMatrix(input, centroid);

    const placedCentroid = Cesium.Matrix4.multiplyByPoint(
      matrix,
      new Cesium.Cartesian3(centroid.x, centroid.y, centroid.z),
      new Cesium.Cartesian3(),
    );
    const expected = Cesium.Cartesian3.fromDegrees(input.anchorLon, input.anchorLat, input.height ?? 0);
    expectCartesianClose(placedCentroid, expected);

    // And the local origin (0,0,0) should NOT land on the anchor in this mode -- it's
    // offset from the centroid by construction, so this is a meaningfully different point.
    const placedOrigin = Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(0, 0, 0), new Cesium.Cartesian3());
    expect(Cesium.Cartesian3.equalsEpsilon(placedOrigin, expected, 0, 1e-6)).toBe(false);
  });

  it('falls back to treating the anchor as local (0,0,0) if model_centroid is requested but no centroid is supplied', () => {
    const input = baseInput({ anchorConvention: 'model_centroid' });
    const matrix = computeGlobeModelMatrix(input); // no centroid argument
    const placed = Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(0, 0, 0), new Cesium.Cartesian3());
    const expected = Cesium.Cartesian3.fromDegrees(input.anchorLon, input.anchorLat, input.height ?? 0);
    expectCartesianClose(placed, expected);
  });

  it('rotationDeg=0 sends a local +Z-ish point due north of the anchor (same convention as localToLatLon)', () => {
    const input = baseInput({ rotationDeg: 0 });
    const matrix = computeGlobeModelMatrix(input);
    const placed = Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(0, 0, 100), new Cesium.Cartesian3());
    const cartographic = Cesium.Cartographic.fromCartesian(placed);
    const anchorCartographic = Cesium.Cartographic.fromDegrees(input.anchorLon, input.anchorLat);

    expect(Cesium.Math.toDegrees(cartographic.latitude)).toBeGreaterThan(input.anchorLat); // moved north
    expect(Cesium.Math.toDegrees(cartographic.longitude)).toBeCloseTo(Cesium.Math.toDegrees(anchorCartographic.longitude), 6);
  });

  it('rotationDeg=90 sends that same local point due east of the anchor instead', () => {
    const input = baseInput({ rotationDeg: 90 });
    const matrix = computeGlobeModelMatrix(input);
    const placed = Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(0, 0, 100), new Cesium.Cartesian3());
    const cartographic = Cesium.Cartographic.fromCartesian(placed);

    expect(Cesium.Math.toDegrees(cartographic.longitude)).toBeGreaterThan(input.anchorLon); // moved east
    expect(Cesium.Math.toDegrees(cartographic.latitude)).toBeCloseTo(input.anchorLat, 6);
  });

  it('preserves height at the anchor position regardless of rotation', () => {
    const input = baseInput({ rotationDeg: 45, height: 500 });
    const matrix = computeGlobeModelMatrix(input);
    const placed = Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(0, 0, 0), new Cesium.Cartesian3());
    const cartographic = Cesium.Cartographic.fromCartesian(placed);
    expect(cartographic.height).toBeCloseTo(500, 3);
  });
});
