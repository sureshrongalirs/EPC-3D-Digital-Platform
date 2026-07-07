import { describe, expect, it } from 'vitest';

import {
  boundingBoxCenter,
  createEmptyBoundingBox,
  expandBoundingBox,
  mergeBoundingBoxes,
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
