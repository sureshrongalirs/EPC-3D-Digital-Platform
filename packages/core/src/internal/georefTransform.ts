import * as THREE from 'three';

/**
 * Single shared source of truth for how a resolved georef rotation is applied to a loaded
 * model's root group -- used by BOTH the GLB and tiles backends (Task 3 design-checkpoint
 * sign-off item 2: no duplicate sign conventions between the two paths).
 *
 * Cross-checked against @plantscope/shared's localToLatLon: rotating a group's local (x, z)
 * by this angle about the Y (up) axis reproduces exactly the same (east, north) rotation
 * sense localToLatLon applies to a local point for the same rotationDeg -- three.js's
 * rotation-about-Y matrix is x' = x*cos+z*sin, z' = -x*sin+z*cos, identical in form to
 * localToLatLon's own east = x*cos+y*sin, north = -x*sin+y*cos (with local Z aliasing
 * localToLatLon's Point2D.y, per MapGeorefPlugin's own footprint convention: {x: p.x, y:
 * p.z}). No sign flip needed -- see georefTransform.test.ts for the cross-check that would
 * catch one if this ever changed.
 */
export function georefRotationRadiansY(rotationDeg: number): number {
  return THREE.MathUtils.degToRad(rotationDeg);
}

/** Applies the resolved rotation to a model's root group/scene node in place. Both
 * Viewer.loadModel()'s GLB branch and loadTilesModel() call this identically -- see Task 3's
 * finding #4: prior to this, the GLB path applied no georef transform at all, so "same as
 * the GLB path" was previously unsatisfiable. */
export function applyGeorefRotation(object: THREE.Object3D, rotationDeg: number): void {
  object.rotation.y = georefRotationRadiansY(rotationDeg);
}
