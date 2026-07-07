import { describe, expect, it } from 'vitest';

import { selectObjectsInRect } from './boxSelect';

describe('selectObjectsInRect', () => {
  it('a left-half rectangle captures exactly the left-half objects — zero loss, zero double-count', () => {
    const width = 800;
    const height = 600;
    const centroids = new Map<string, { x: number; y: number } | null>();
    const leftIds = new Set<string>();
    const rightIds = new Set<string>();

    let counter = 0;
    for (let x = 0; x < width; x += 20) {
      for (let y = 0; y < height; y += 20) {
        const id = `obj-${counter}`;
        counter += 1;
        centroids.set(id, { x, y });
        if (x < width / 2) {
          leftIds.add(id);
        } else {
          rightIds.add(id);
        }
      }
    }
    // Off-screen / behind-camera objects must never be selected.
    centroids.set('behind-camera-1', null);
    centroids.set('behind-camera-2', null);

    const selected = selectObjectsInRect(centroids, {
      x1: 0,
      y1: 0,
      x2: width / 2 - 0.01,
      y2: height,
    });

    expect(new Set(selected)).toEqual(leftIds);
    expect(selected).toHaveLength(leftIds.size); // zero double-count
    expect(new Set(selected).size).toBe(selected.length);
    for (const id of selected) {
      expect(rightIds.has(id)).toBe(false); // zero loss into the wrong half
    }
    expect(selected).not.toContain('behind-camera-1');
    expect(selected).not.toContain('behind-camera-2');
  });

  it('normalizes an inverted rectangle (dragged bottom-right to top-left)', () => {
    const centroids = new Map<string, { x: number; y: number } | null>([
      ['a', { x: 5, y: 5 }],
      ['b', { x: 50, y: 50 }],
    ]);
    const normal = selectObjectsInRect(centroids, { x1: 0, y1: 0, x2: 10, y2: 10 });
    const inverted = selectObjectsInRect(centroids, { x1: 10, y1: 10, x2: 0, y2: 0 });
    expect(normal).toEqual(['a']);
    expect(inverted).toEqual(normal);
  });

  it('returns an empty array when nothing falls inside the rect', () => {
    const centroids = new Map<string, { x: number; y: number } | null>([['a', { x: 500, y: 500 }]]);
    expect(selectObjectsInRect(centroids, { x1: 0, y1: 0, x2: 10, y2: 10 })).toEqual([]);
  });
});
