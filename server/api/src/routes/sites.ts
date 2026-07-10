import crypto from 'node:crypto';

import { Router } from 'express';

import type { Database } from '@plantscope/server-shared';
import { createSite, getSiteRow, listSiteRows, recordAudit, toSiteDto, updateSiteRotation } from '@plantscope/server-shared';

import { badRequest, notFound } from '../lib/problem.js';

export function createSitesRouter(db: Database): Router {
  const router = Router();

  // POST /api/sites — create (name, optional initial rotation_deg).
  router.post('/sites', async (req, res) => {
    const body = (req.body ?? {}) as { name?: string; rotationDeg?: number | null };
    if (typeof body.name !== 'string' || !body.name) throw badRequest('name is required');

    const row = await createSite(db, { id: crypto.randomUUID(), name: body.name, rotationDeg: body.rotationDeg ?? null });
    await recordAudit(db, { action: 'site.create', subject: row.id });

    res.status(201).json(toSiteDto(row));
  });

  // GET /api/sites
  router.get('/sites', async (_req, res) => {
    res.json((await listSiteRows(db)).map(toSiteDto));
  });

  // GET /api/sites/{id}
  router.get('/sites/:id', async (req, res) => {
    const row = await getSiteRow(db, req.params.id);
    if (!row) throw notFound(`site ${req.params.id} not found`);
    res.json(toSiteDto(row));
  });

  // PATCH /api/sites/{id} — "save as site default". Response includes the count of other
  // models at this site whose georef now shows rotation_source='site_inherited'.
  router.patch('/sites/:id', async (req, res) => {
    const body = (req.body ?? {}) as { rotationDeg?: number };
    if (typeof body.rotationDeg !== 'number') throw badRequest('rotationDeg is required');

    const result = await updateSiteRotation(db, req.params.id, body.rotationDeg);
    if (!result) throw notFound(`site ${req.params.id} not found`);
    await recordAudit(db, {
      action: 'site.rotation.update',
      subject: req.params.id,
      detail: { rotationDeg: body.rotationDeg, affectedModelsCount: result.affectedModelsCount },
    });

    res.json({ site: toSiteDto(result.site), affectedModelsCount: result.affectedModelsCount });
  });

  return router;
}
