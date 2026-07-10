import type { GeorefMethod, RotationSource } from '@plantscope/shared';

export interface GeorefStatusInput {
  method: GeorefMethod;
  rotationSource: RotationSource;
}

const ROTATION_SOURCE_LABEL: Record<RotationSource, string> = {
  model_override: 'Custom for this model',
  site_inherited: 'Site default',
  default: 'Not set',
};

/**
 * Mirrors MapGeorefPlugin's badge concept (method + rotationSource -> one human-readable
 * line) so the 2D map and 3D globe views describe the same placement the same way. The
 * globe view leans more emphatic about method='assumed' than the map's badge does -- a
 * misplaced model is far more visually convincing floating on a photorealistic globe than
 * it is on a flat 2D map, so this is deliberately not subtle (point 6/4 of the Phase 5 task:
 * never render an unsurveyed placement as if it were authoritative).
 */
export function describeGeorefStatus(georef: GeorefStatusInput): string {
  const rotationLabel = ROTATION_SOURCE_LABEL[georef.rotationSource];
  const label = `${rotationLabel} (method: ${georef.method})`;
  return georef.method === 'assumed' ? `⚠ UNSURVEYED PLACEMENT — ${label} — treat this location as a rough guess only` : label;
}
