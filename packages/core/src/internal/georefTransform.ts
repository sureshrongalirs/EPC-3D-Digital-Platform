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

/**
 * Guards `applyGeorefRotation` against a reload race: `Viewer.loadModel()`/`loadTilesModel()`
 * fetch the resolved georef rotation over the network (an unavoidable await), and neither
 * method has any concurrency guard against a second `loadModel()` call superseding the first
 * one's model group while that fetch is still in flight (PR #14 verification's adversarial
 * finding). Without this guard, a stale continuation reading `this.modelGroup` again *after*
 * its own await would either throw (a concurrent `unloadModel()` already nulled it) or, worse,
 * silently rotate the WRONG (current, superseding) model.
 *
 * `expectedGroup` is captured by the caller *before* the await; `getCurrentGroup` is called
 * *after* `fetchRotationDeg` resolves, reading whatever is live at that moment. If they no
 * longer match, this is a silent no-op -- never a throw, never a rotation applied to state a
 * newer load already owns. This is a narrow symptom guard, not the full fix: it stops the
 * one observable bad effect (a wrong/crashing rotation), but the rest of the stale
 * continuation's work (`fitToModel()`, `modelLoaded` events, etc.) is unguarded, and a
 * possibly-orphaned tiles renderer isn't cleaned up either -- see the follow-up list for the
 * real fix (a load-generation counter invalidating every stale continuation at once, which a
 * future multi-model ModelManager would need anyway and would resolve this class of bug
 * wholesale, not just this one symptom).
 */
export async function applyGeorefRotationIfStillCurrent(
  expectedGroup: THREE.Object3D,
  getCurrentGroup: () => THREE.Object3D | null,
  fetchRotationDeg: () => Promise<number>,
): Promise<void> {
  const rotationDeg = await fetchRotationDeg();
  if (getCurrentGroup() === expectedGroup) {
    applyGeorefRotation(expectedGroup, rotationDeg);
  }
}
