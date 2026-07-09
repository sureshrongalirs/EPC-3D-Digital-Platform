import * as Cesium from 'cesium';

import type { AnchorConvention } from '@plantscope/shared';

export interface GlobeTransformInput {
  anchorLat: number;
  anchorLon: number;
  /** Ellipsoidal or orthometric height in meters; treated as 0 if unset (unknown height
   * datum) -- this function never guesses a datum, it just needs *a* number to place the
   * anchor at. Callers surface height_datum='unknown' to the user separately. */
  height: number | null;
  rotationDeg: number;
  anchorConvention: AnchorConvention;
}

export interface ModelCentroid {
  x: number;
  y: number;
  z: number;
}

/**
 * Computes the Cesium model matrix that places a model's local-space geometry (three.js'
 * Y-up convention: X/Z horizontal, Y vertical -- the same convention @plantscope/core's
 * Viewer and getObjectBounds use) correctly on the WGS84 ellipsoid, from its georef record.
 *
 * Math (mirrors @plantscope/shared's localToLatLon rotation convention exactly -- rotationDeg
 * is degrees clockwise from north -- so the 2D map and 3D globe views never disagree about
 * which way "rotated" points):
 *
 *   1. Rotate the horizontal plane by rotationDeg into Cesium's east-north-up (ENU) basis
 *      (Transforms.eastNorthUpToFixedFrame's local axes: x=East, y=North, z=Up):
 *        east  =  x*cos(theta) + z*sin(theta)
 *        north = -x*sin(theta) + z*cos(theta)
 *        up    =  y
 *      (This is @plantscope/shared's localToLatLon formula, generalized to 3D by carrying
 *      the vertical Y axis straight through to "up" -- rotationDeg is yaw-only, no
 *      pitch/roll, matching the 2D map's single-angle rotation model.)
 *   2. Place that rotated local frame in ECEF via Cesium.Transforms.eastNorthUpToFixedFrame
 *      at the anchor position (lat/lon/height) -- this one Cesium call supplies the
 *      anchor's own ellipsoid-normal "up" direction and the ENU -> ECEF rotation+translation;
 *      this function only contributes the extra yaw on top of it.
 *   3. If anchorConvention is 'model_centroid' (the anchor corresponds to the model's
 *      centroid, not literal local (0,0,0)), fold in a pre-translation so `modelCentroid`
 *      becomes the effective local origin before the rotation+placement above is applied.
 *      `modelCentroid` is required for this case; if it's not supplied the pre-translation
 *      is skipped and the anchor is treated as sitting at local (0,0,0) instead (same as
 *      'model_origin') -- callers are expected to always pass it when they have one (the
 *      model's own ModelDto.bboxMin/bboxMax midpoint), this fallback only exists so a
 *      missing centroid degrades to "roughly right" rather than throwing.
 */
export function computeGlobeModelMatrix(input: GlobeTransformInput, modelCentroid?: ModelCentroid): Cesium.Matrix4 {
  const height = input.height ?? 0;
  const anchorCartesian = Cesium.Cartesian3.fromDegrees(input.anchorLon, input.anchorLat, height);
  const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(anchorCartesian);

  const theta = Cesium.Math.toRadians(input.rotationDeg);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Row-major: row0 -> east, row1 -> north, row2 -> up (see doc comment above).
  const localToEnuRotation = new Cesium.Matrix3(cos, 0, sin, -sin, 0, cos, 0, 1, 0);
  const localToEnu = Cesium.Matrix4.fromRotationTranslation(localToEnuRotation, Cesium.Cartesian3.ZERO);

  let modelMatrix = Cesium.Matrix4.multiply(enuToFixed, localToEnu, new Cesium.Matrix4());

  if (input.anchorConvention === 'model_centroid' && modelCentroid) {
    const centroidTranslation = Cesium.Matrix4.fromTranslation(
      new Cesium.Cartesian3(-modelCentroid.x, -modelCentroid.y, -modelCentroid.z),
    );
    modelMatrix = Cesium.Matrix4.multiply(modelMatrix, centroidTranslation, new Cesium.Matrix4());
  }

  return modelMatrix;
}
