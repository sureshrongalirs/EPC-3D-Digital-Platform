import { describe, expect, it } from 'vitest';

import { createCollisionTracker, encodeObjectFilename } from './objectIdentity.js';

describe('encodeObjectFilename', () => {
  it('encodes a single-segment path (flat-tree case) to a short, readable filename', () => {
    const tracker = createCollisionTracker();
    expect(encodeObjectFilename(['Object_6'], tracker)).toBe('Object_6.glb');
  });

  it('joins a multi-segment path with the segment separator, in order', () => {
    const tracker = createCollisionTracker();
    expect(encodeObjectFilename(['Building_0', 'Floor_0', 'Room_0', 'Valve'], tracker)).toBe('Building_0__Floor_0__Room_0__Valve.glb');
  });

  it('sanitizes filesystem-unsafe characters deterministically', () => {
    const tracker = createCollisionTracker();
    expect(encodeObjectFilename(['Pump #3 (east)'], tracker)).toBe('Pump_3_east.glb');
  });

  it('collapses repeated unsafe characters into one underscore rather than many', () => {
    const tracker = createCollisionTracker();
    expect(encodeObjectFilename(['A   B'], tracker)).toBe('A_B.glb');
  });

  it('assigns stable, deterministic ordinals to exact-duplicate encoded paths', () => {
    const tracker = createCollisionTracker();
    expect(encodeObjectFilename(['Room_0'], tracker)).toBe('Room_0.glb');
    expect(encodeObjectFilename(['Room_0'], tracker)).toBe('Room_0-2.glb');
    expect(encodeObjectFilename(['Room_0'], tracker)).toBe('Room_0-3.glb');
  });

  it('re-running the same sequence against a fresh tracker reproduces the same ordinals (deterministic, not order-of-Map-iteration dependent)', () => {
    const paths = [['Room_0'], ['Room_1'], ['Room_0'], ['Room_0']];
    const first = paths.map((p) => encodeObjectFilename(p, createCollisionTracker()));
    // A fresh tracker per call isn't the real usage pattern (real usage shares one tracker
    // across a whole traversal) -- this asserts the *encoding itself* has no hidden state
    // beyond the tracker, by re-running the real shared-tracker pattern twice and comparing.
    const trackerA = createCollisionTracker();
    const runA = paths.map((p) => encodeObjectFilename(p, trackerA));
    const trackerB = createCollisionTracker();
    const runB = paths.map((p) => encodeObjectFilename(p, trackerB));
    expect(runA).toEqual(runB);
    expect(first[0]).toBe('Room_0.glb');
  });

  it('case-insensitive collision safety: names differing only by case still collide and get ordinals (Windows/NTFS + macOS default filesystems are case-insensitive)', () => {
    const tracker = createCollisionTracker();
    expect(encodeObjectFilename(['Room_0'], tracker)).toBe('Room_0.glb');
    expect(encodeObjectFilename(['room_0'], tracker)).toBe('room_0-2.glb');
    expect(encodeObjectFilename(['ROOM_0'], tracker)).toBe('ROOM_0-3.glb');
    // A genuinely different name never collides.
    expect(encodeObjectFilename(['Room_1'], tracker)).toBe('Room_1.glb');
  });

  it('never produces an empty filename for a degenerate all-unsafe-characters path', () => {
    const tracker = createCollisionTracker();
    expect(encodeObjectFilename(['###'], tracker)).toBe('_.glb');
    expect(encodeObjectFilename(['###'], tracker)).toBe('_-2.glb');
  });
});
