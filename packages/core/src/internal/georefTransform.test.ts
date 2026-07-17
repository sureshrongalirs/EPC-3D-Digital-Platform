import { localToLatLon } from '@plantscope/shared';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { applyGeorefRotation, applyGeorefRotationIfStillCurrent, georefRotationRadiansY } from './georefTransform';

const ANCHOR = { lat: 10, lon: 20 };

describe('applyGeorefRotation (cross-checked against @plantscope/shared localToLatLon)', () => {
  it('rotating a group by rotationDeg and re-reading (x,z) at rotationDeg=0 matches calling localToLatLon directly at that rotationDeg -- would catch a sign flip', () => {
    for (const rotationDeg of [0, 37, -90, 180, 271, -13.5]) {
      const local = new THREE.Vector3(120, 5, -45); // arbitrary local X/Y/Z offset
      const group = new THREE.Group();
      applyGeorefRotation(group, rotationDeg);
      group.updateMatrixWorld();
      const rotated = local.clone().applyMatrix4(group.matrixWorld);

      const direct = localToLatLon({ x: local.x, y: local.z }, ANCHOR, rotationDeg);
      const viaTransform = localToLatLon({ x: rotated.x, y: rotated.z }, ANCHOR, 0);

      expect(viaTransform.lat).toBeCloseTo(direct.lat, 9);
      expect(viaTransform.lon).toBeCloseTo(direct.lon, 9);
    }
  });

  it('rotationDeg 0 is a no-op', () => {
    expect(georefRotationRadiansY(0)).toBe(0);
  });

  it('leaves the Y (up) coordinate untouched -- this is a Y-axis rotation only', () => {
    const local = new THREE.Vector3(10, 42, -7);
    const group = new THREE.Group();
    applyGeorefRotation(group, 55);
    group.updateMatrixWorld();
    const rotated = local.clone().applyMatrix4(group.matrixWorld);
    expect(rotated.y).toBeCloseTo(42, 9);
  });
});

describe('applyGeorefRotationIfStillCurrent (PR #14 verification adversarial finding -- reload race guard)', () => {
  it('applies the rotation normally when nothing superseded the group while the fetch was in flight', async () => {
    const groupA = new THREE.Group();
    await applyGeorefRotationIfStillCurrent(groupA, () => groupA, async () => 45);
    expect(groupA.rotation.y).toBeCloseTo(georefRotationRadiansY(45), 9);
  });

  it('simulates the race: load A starts, load B supersedes A\'s group while A\'s georef fetch is still pending, A resolves last -- no throw, A\'s stale rotation is never applied, B is never touched', async () => {
    const groupA = new THREE.Group();
    const groupB = new THREE.Group();
    let current: THREE.Object3D = groupA; // stands in for Viewer's `this.modelGroup`

    let resolveFetch!: (deg: number) => void;
    const pendingFetch = new Promise<number>((resolve) => {
      resolveFetch = resolve;
    });

    // Load A starts: captures its own group, then suspends on the georef fetch (exactly
    // Viewer.loadModel()'s `await this.fetchGeorefRotationDeg(id)` point).
    const loadAContinuation = applyGeorefRotationIfStillCurrent(groupA, () => current, () => pendingFetch);

    // Load B runs to completion *while A is still suspended* -- unloadModel() + a fresh
    // modelGroup assignment, exactly as a second loadModel() call would do.
    current = groupB;

    // A's fetch finally resolves, long after B already took over.
    resolveFetch(45);
    await expect(loadAContinuation).resolves.toBeUndefined(); // no throw

    expect(groupA.rotation.y).toBe(0); // A's own (stale) rotation was never applied
    expect(groupB.rotation.y).toBe(0); // B was never touched by A's continuation either
  });

  it('never throws when getCurrentGroup returns null (e.g. a concurrent unloadModel() with no new load started yet)', async () => {
    const groupA = new THREE.Group();
    await expect(applyGeorefRotationIfStillCurrent(groupA, () => null, async () => 45)).resolves.toBeUndefined();
    expect(groupA.rotation.y).toBe(0);
  });
});
