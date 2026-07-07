import { describe, expect, it } from 'vitest';

import type { PickRange } from './picking';
import { resolveObjectByTriangleIndex } from './picking';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds N objects with random, contiguous, non-overlapping triangle ranges. */
function buildRandomRanges(rng: () => number, objectCount: number): PickRange[] {
  const ranges: PickRange[] = [];
  let cursor = 0;
  for (let i = 0; i < objectCount; i += 1) {
    const triCount = 1 + Math.floor(rng() * 20);
    ranges.push({ start: cursor, end: cursor + triCount, objectId: `object-${i}` });
    cursor += triCount;
  }
  return ranges;
}

describe('resolveObjectByTriangleIndex (property-based)', () => {
  const trials = 200;

  for (let trial = 0; trial < trials; trial += 1) {
    it(`trial ${trial}: every triangle index maps to its owning object`, () => {
      const rng = mulberry32(trial + 1);
      const objectCount = 1 + Math.floor(rng() * 50);
      const ranges = buildRandomRanges(rng, objectCount);
      const totalTriangles = ranges[ranges.length - 1]!.end;

      // Exhaustively check every triangle index in range, plus both boundaries of each range.
      for (let t = 0; t < totalTriangles; t += 1) {
        const owner = ranges.find((r) => t >= r.start && t < r.end);
        expect(resolveObjectByTriangleIndex(ranges, t)).toBe(owner?.objectId ?? null);
      }

      for (const range of ranges) {
        expect(resolveObjectByTriangleIndex(ranges, range.start)).toBe(range.objectId);
        expect(resolveObjectByTriangleIndex(ranges, range.end - 1)).toBe(range.objectId);
      }
    });
  }

  it('returns null for indices outside every range', () => {
    const ranges: PickRange[] = [
      { start: 0, end: 10, objectId: 'a' },
      { start: 10, end: 20, objectId: 'b' },
    ];
    expect(resolveObjectByTriangleIndex(ranges, -1)).toBeNull();
    expect(resolveObjectByTriangleIndex(ranges, 20)).toBeNull();
    expect(resolveObjectByTriangleIndex(ranges, 1000)).toBeNull();
  });

  it('returns null for an empty range table', () => {
    expect(resolveObjectByTriangleIndex([], 0)).toBeNull();
  });
});
