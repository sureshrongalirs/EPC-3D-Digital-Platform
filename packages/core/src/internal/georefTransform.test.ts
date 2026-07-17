import { localToLatLon } from '@plantscope/shared';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { applyGeorefRotation, georefRotationRadiansY } from './georefTransform';

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
