import { describe, expect, it } from 'vitest';

import { computeZoneBoundary } from './zoneBoundary';

describe('computeZoneBoundary', () => {
  it('unions the X/Z footprint and Y range across multiple member bboxes', () => {
    const boundary = computeZoneBoundary([
      { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 2 } },
      { min: { x: 5, y: -1, z: 5 }, max: { x: 6, y: 3, z: 6 } },
    ]);

    expect(boundary.zmin).toBe(-1);
    expect(boundary.zmax).toBe(3);

    const xs = boundary.footprint.map((p) => p.x);
    const ys = boundary.footprint.map((p) => p.y);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(6);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(6);
  });

  it('returns an empty boundary for zero members', () => {
    expect(computeZoneBoundary([])).toEqual({ footprint: [], zmin: 0, zmax: 0 });
  });
});
