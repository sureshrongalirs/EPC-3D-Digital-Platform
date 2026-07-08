import type { Database } from '../db/index.js';
import type { SiteRow } from '../types.js';

export type RotationSource = 'model_override' | 'site_inherited' | 'default';

export interface ResolvedRotation {
  rotationDeg: number;
  rotationSource: RotationSource;
}

/**
 * Rotation precedence is resolved by whoever WRITES a georef row, never by the reader
 * (see CLAUDE.md's Georeferencing invariants): (a) an explicit rotation on this write
 * wins outright ('model_override'); (b) else, the model's site's saved rotation, if any
 * ('site_inherited'); (c) else 0, flagged for manual alignment ('default'). One function,
 * reused verbatim by the Phase 4 worker.
 */
export async function resolveRotation(
  db: Database,
  siteId: string | null | undefined,
  explicitRotationDeg: number | null | undefined,
): Promise<ResolvedRotation> {
  if (explicitRotationDeg !== null && explicitRotationDeg !== undefined) {
    return { rotationDeg: explicitRotationDeg, rotationSource: 'model_override' };
  }

  if (siteId) {
    const site = await db.knex<SiteRow>('sites').where({ id: siteId }).first();
    if (site && site.rotation_deg !== null && site.rotation_deg !== undefined) {
      return { rotationDeg: site.rotation_deg, rotationSource: 'site_inherited' };
    }
  }

  return { rotationDeg: 0, rotationSource: 'default' };
}
