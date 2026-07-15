import { describe, expect, it } from 'vitest';

import { type Mat4, type Vec3, normalMatrixFrom, normalize3, transformDirection, transformPoint } from './worldTransform.js';

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function translationMatrix(tx: number, ty: number, tz: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
}

/** Non-uniform scale, column-major. */
function scaleMatrix(sx: number, sy: number, sz: number): Mat4 {
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];
}

function approxEqual(a: readonly number[], b: readonly number[], tol = 1e-9): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < tol);
}

describe('transformPoint', () => {
  it('identity leaves a point unchanged', () => {
    expect(approxEqual(transformPoint(IDENTITY, [1, 2, 3]), [1, 2, 3])).toBe(true);
  });

  it('applies translation', () => {
    expect(approxEqual(transformPoint(translationMatrix(10, -20, 30), [1, 2, 3]), [11, -18, 33])).toBe(true);
  });

  it('applies non-uniform scale', () => {
    expect(approxEqual(transformPoint(scaleMatrix(2, 0.5, 3), [1, 1, 1]), [2, 0.5, 3])).toBe(true);
  });
});

describe('normalMatrixFrom + transformDirection: the whole point of this module', () => {
  it('under UNIFORM scale, the normal matrix transform agrees with naively applying the matrix directly (no divergence when there is nothing to diverge over)', () => {
    const m = scaleMatrix(2, 2, 2);
    const normalMatrix = normalMatrixFrom(m)!;
    const naive = transformDirection([2, 0, 0, 0, 2, 0, 0, 0, 2], [1, 0, 0]);
    const correct = normalize3(transformDirection(normalMatrix, [1, 0, 0]));
    // Both should point the same direction (magnitude differs, direction must agree) --
    // uniform scale doesn't rotate normals away from the surface.
    expect(approxEqual(normalize3(naive), correct)).toBe(true);
  });

  it('under NON-UNIFORM scale, naively transforming a normal by the same matrix as positions gives the WRONG direction -- this is the exact bug class this module exists to prevent', () => {
    // A 45-degree-ish diagonal normal on a surface, non-uniformly squashed along X.
    const m = scaleMatrix(4, 1, 1);
    const originalNormal: Vec3 = normalize3([1, 1, 0]);

    const naiveWrong = normalize3(transformDirection([4, 0, 0, 0, 1, 0, 0, 0, 1], originalNormal));
    const normalMatrix = normalMatrixFrom(m)!;
    const correct = normalize3(transformDirection(normalMatrix, originalNormal));

    // The naive approach tilts the normal toward the squashed axis; the correct
    // inverse-transpose approach tilts it AWAY from the squashed axis (toward the axis that
    // was NOT compressed) -- they must disagree here, proving the distinction is real and
    // this test would catch a regression to the naive (wrong) approach.
    expect(approxEqual(naiveWrong, correct)).toBe(false);

    // For scale-only diag(sx,sy,sz), the correct inverse-transpose normal transform is exactly
    // diag(1/sx, 1/sy, 1/sz) (self-inverse-transpose for a diagonal matrix) -- verify directly
    // against that independently-known closed form, not just "differs from naive".
    const expected = normalize3([originalNormal[0] / 4, originalNormal[1] / 1, originalNormal[2] / 1]);
    expect(approxEqual(correct, expected, 1e-6)).toBe(true);
  });

  it('a transformed normal stays unit length after normalize3', () => {
    const m = scaleMatrix(5, 0.2, 3);
    const normalMatrix = normalMatrixFrom(m)!;
    const result = normalize3(transformDirection(normalMatrix, normalize3([0.3, 0.5, 0.8])));
    expect(Math.hypot(...result)).toBeCloseTo(1, 9);
  });

  it('returns null for a singular (dimension-collapsing) transform rather than a silently-wrong answer', () => {
    expect(normalMatrixFrom(scaleMatrix(1, 0, 1))).toBeNull();
  });

  it('identity matrix leaves a normal unchanged', () => {
    const normalMatrix = normalMatrixFrom(IDENTITY)!;
    const n: Vec3 = normalize3([1, 2, 3]);
    expect(approxEqual(normalize3(transformDirection(normalMatrix, n)), n)).toBe(true);
  });
});
