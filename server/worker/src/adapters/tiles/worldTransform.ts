/**
 * Small, dependency-free affine-transform math for Task 2's splitter.ts. Pure functions, no
 * I/O, own unit tests -- extracted rather than inlined so the position-vs-normal transform
 * rules (easy to get subtly wrong under non-uniform scale) are independently testable.
 *
 * Why this exists at all: real mago-3d-tiler v1.15.4 was confirmed (WSL spot-check, Task 2
 * PR) to silently DROP a source GLB node's rotation when the node carries a combined
 * rotation+non-uniform-scale "matrix" property -- it appears to decompose the matrix and only
 * recovers scale correctly. splitter.ts therefore bakes every object's full world transform
 * directly into its vertex data at split time and ships an identity node transform, removing
 * matrix decomposition from the pipeline entirely (mago never has a non-trivial matrix to
 * misinterpret). See docs/phase5r/task2-findings.md for the before/after vertex evidence.
 */

export type Vec3 = readonly [number, number, number];
/** 16 elements, column-major (glTF/gl-matrix convention: m[12..14] is the translation). */
export type Mat4 = ArrayLike<number>;

/** Applies `m` (as an affine transform, w=1) to a point -- the correct rule for vertex
 * positions. */
export function transformPoint(m: Mat4, v: Vec3): Vec3 {
  const [x, y, z] = v;
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

function mat3Invert(a: readonly number[]): number[] | null {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a as [number, number, number, number, number, number, number, number, number];
  const b01 = a8 * a4 - a5 * a7;
  const b11 = -a8 * a3 + a5 * a6;
  const b21 = a7 * a3 - a4 * a6;
  const det = a0 * b01 + a1 * b11 + a2 * b21;
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return [
    b01 * invDet,
    (-a8 * a1 + a2 * a7) * invDet,
    (a5 * a1 - a2 * a4) * invDet,
    b11 * invDet,
    (a8 * a0 - a2 * a6) * invDet,
    (-a5 * a0 + a2 * a3) * invDet,
    b21 * invDet,
    (-a7 * a0 + a1 * a6) * invDet,
    (a4 * a0 - a1 * a3) * invDet,
  ];
}

function mat3Transpose(a: readonly number[]): number[] {
  return [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!];
}

/**
 * The correct transform for a NORMAL vector under an affine transform `m` is the
 * inverse-transpose of `m`'s upper-left 3x3, not `m` itself -- under non-uniform scale the two
 * diverge (a naive same-matrix transform tilts normals away from the surface they're supposed
 * to be perpendicular to, breaking lighting invisibly rather than crashing). Returns `null`
 * when the upper-left 3x3 is singular (a degenerate, dimension-collapsing transform, e.g. a
 * zero scale on some axis) -- there is no mathematically correct normal transform in that
 * case; callers should fall back to the plain upper-left 3x3 and flag it rather than silently
 * producing a wrong-but-plausible-looking normal.
 *
 * TANGENT vectors (glTF's TANGENT attribute, a vec4 with a handedness sign in .w) need a
 * related but distinct rule: transform the xyz by `m` directly (tangents follow the surface's
 * own parameterization, not its perpendicular), then re-orthogonalize against the already-
 * transformed normal (Gram-Schmidt: t' = normalize(t - n*dot(n,t))) and preserve the original
 * handedness sign. Not implemented here -- no fixture or real client file inspected so far
 * (docs/phase5r/task2-kickoff-amendment.md's real-file summary: "zero textures") carries a
 * TANGENT attribute, so this is a documented gap, not a silent one: splitter.ts warns if it
 * ever encounters one rather than baking it wrong.
 */
export function normalMatrixFrom(m: Mat4): number[] | null {
  const upper3x3 = [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!];
  const inverted = mat3Invert(upper3x3);
  return inverted ? mat3Transpose(inverted) : null;
}

export function transformDirection(mat3: readonly number[], v: Vec3): Vec3 {
  const [x, y, z] = v;
  return [mat3[0]! * x + mat3[3]! * y + mat3[6]! * z, mat3[1]! * x + mat3[4]! * y + mat3[7]! * z, mat3[2]! * x + mat3[5]! * y + mat3[8]! * z];
}

export function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len < 1e-12 ? v : [v[0] / len, v[1] / len, v[2] / len];
}
