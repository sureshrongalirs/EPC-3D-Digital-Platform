import crypto from 'node:crypto';

import { Router } from 'express';

import type { Database } from '../db/index.js';
import { badRequest, notFound } from '../lib/problem.js';
import { recordAudit } from '../repo/audit.js';
import { getModelRow } from '../repo/models.js';
import { deleteZone, getZoneMembers, getZoneRow, listZoneRows, toZoneDto, upsertZone } from '../repo/zones.js';

interface ZoneRequestBody {
  id?: string;
  modelId?: string;
  name?: string;
  color?: string;
  members?: string[];
  footprint?: { x: number; y: number }[];
  zmin?: number;
  zmax?: number;
}

export function createZonesRouter(db: Database): Router {
  const router = Router();

  // POST /api/zones — upsert (see ZonesPlugin: create/rename/recolor/add-members/
  // remove-member all POST here with the zone's full current state).
  router.post('/zones', async (req, res) => {
    const body = (req.body ?? {}) as ZoneRequestBody;
    if (
      !body.modelId ||
      !body.name ||
      !body.color ||
      !Array.isArray(body.members) ||
      !Array.isArray(body.footprint) ||
      typeof body.zmin !== 'number' ||
      typeof body.zmax !== 'number'
    ) {
      throw badRequest('modelId, name, color, members, footprint, zmin, and zmax are required');
    }

    const model = await getModelRow(db, body.modelId);
    if (!model) throw notFound(`model ${body.modelId} not found`);

    const id = body.id || crypto.randomUUID();
    const row = await upsertZone(db, {
      id,
      modelId: body.modelId,
      name: body.name,
      color: body.color,
      footprintLocal: body.footprint,
      zmin: body.zmin,
      zmax: body.zmax,
      memberLinkageKeys: body.members,
      memberRevision: model.current_revision ?? 0,
    });
    await recordAudit(db, { action: 'zone.upsert', subject: row.id, detail: { modelId: body.modelId } });

    res.status(201).json(toZoneDto(row));
  });

  // GET /api/zones?model={id}
  router.get('/zones', async (req, res) => {
    const modelId = typeof req.query['model'] === 'string' ? req.query['model'] : undefined;
    res.json((await listZoneRows(db, modelId)).map(toZoneDto));
  });

  // GET /api/zones/{id}/members
  router.get('/zones/:id/members', async (req, res) => {
    const zone = await getZoneRow(db, req.params.id);
    if (!zone) throw notFound(`zone ${req.params.id} not found`);
    const members = await getZoneMembers(db, zone.id);
    res.json(members.map((m) => ({ linkageKey: m.linkage_key, revision: m.revision })));
  });

  // DELETE /api/zones/{id}
  router.delete('/zones/:id', async (req, res) => {
    const deleted = await deleteZone(db, req.params.id);
    if (!deleted) throw notFound(`zone ${req.params.id} not found`);
    await recordAudit(db, { action: 'zone.delete', subject: req.params.id });
    res.status(204).send();
  });

  return router;
}
