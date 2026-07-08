import { Router } from 'express';

import type { Database } from '@plantscope/server-shared';
import { getGeorefRow, getModelRow, recordAudit, resetGeoref, toGeorefDto, upsertGeoref } from '@plantscope/server-shared';

import { badRequest, notFound } from '../lib/problem.js';

interface GeorefRequestBody {
  anchorLat?: number;
  anchorLon?: number;
  height?: number | null;
  heightDatum?: 'ellipsoidal' | 'orthometric' | 'unknown';
  rotationDeg?: number | null;
  method?: 'assumed' | 'provided' | 'provided+adjusted' | 'surveyed' | 'authoritative';
  anchorConvention?: 'model_origin' | 'model_centroid';
}

export function createGeorefRouter(db: Database): Router {
  const router = Router();

  // POST /api/models/{id}/georef — upsert. rotationDeg omitted -> resolved via site
  // inheritance/default (see lib/rotationPrecedence.ts); rotationDeg given -> model_override.
  router.post('/models/:id/georef', async (req, res) => {
    const model = await getModelRow(db, req.params.id);
    if (!model) throw notFound(`model ${req.params.id} not found`);

    const body = (req.body ?? {}) as GeorefRequestBody;
    if (typeof body.anchorLat !== 'number' || typeof body.anchorLon !== 'number') {
      throw badRequest('anchorLat and anchorLon are required numbers');
    }

    const row = await upsertGeoref(db, model.id, model.site_id, model.current_revision, {
      anchorLat: body.anchorLat,
      anchorLon: body.anchorLon,
      height: body.height ?? null,
      heightDatum: body.heightDatum,
      rotationDeg: body.rotationDeg ?? null,
      method: body.method,
      anchorConvention: body.anchorConvention,
    });
    await recordAudit(db, { action: 'georef.upsert', subject: model.id });

    res.status(200).json(toGeorefDto(row));
  });

  // GET /api/models/{id}/georef
  router.get('/models/:id/georef', async (req, res) => {
    const row = await getGeorefRow(db, req.params.id);
    if (!row) throw notFound(`no georef for model ${req.params.id}`);
    res.json(toGeorefDto(row));
  });

  // POST /api/models/{id}/georef/reset — clear model-level override, fall back to site
  // inheritance/default.
  router.post('/models/:id/georef/reset', async (req, res) => {
    const model = await getModelRow(db, req.params.id);
    if (!model) throw notFound(`model ${req.params.id} not found`);

    const row = await resetGeoref(db, model.id, model.site_id);
    if (!row) throw notFound(`no georef for model ${req.params.id}`);
    await recordAudit(db, { action: 'georef.reset', subject: model.id });

    res.json(toGeorefDto(row));
  });

  return router;
}
