import { Router } from 'express';

import type { Database } from '@plantscope/server-shared';
import { getComponent, getModelRow, listComponentBboxesByModel, toComponentDto } from '@plantscope/server-shared';

import { badRequest, notFound } from '../lib/problem.js';

export function createComponentsRouter(db: Database): Router {
  const router = Router();

  // GET /api/components?model={id}&fields=bbox -- every component's bbox for the model's
  // current revision in one query. Used by @plantscope/core's Viewer for
  // getObjectScreenCentroids() on OGC 3D Tiles models, whose objects may live in tiles that
  // aren't currently streamed in (so their centroid can't be read off any live three.js
  // geometry the way the GLB path does -- see CLAUDE.md invariant #4). `fields=bbox` is
  // required and currently the only supported value -- it's an explicit opt-in (rather than
  // always returning bboxes) so a future full-props bulk listing doesn't silently change this
  // endpoint's response shape for existing callers.
  router.get('/components', async (req, res) => {
    const modelId = req.query['model'];
    if (typeof modelId !== 'string' || !modelId) throw badRequest('missing ?model=<id> query param');
    if (req.query['fields'] !== 'bbox') throw badRequest('missing or unsupported ?fields= query param (only "bbox" is supported)');

    const model = await getModelRow(db, modelId);
    if (!model) throw notFound(`model ${modelId} not found`);
    if (model.current_revision === null) {
      res.json([]);
      return;
    }

    res.json(await listComponentBboxesByModel(db, modelId, model.current_revision));
  });

  // GET /api/components/{key}?model={id} — joined engineering properties.
  router.get('/components/:key', async (req, res) => {
    const modelId = req.query['model'];
    if (typeof modelId !== 'string' || !modelId) throw badRequest('missing ?model=<id> query param');

    const row = await getComponent(db, modelId, req.params.key);
    if (!row) throw notFound(`no component "${req.params.key}" for model ${modelId}`);

    res.json(toComponentDto(row));
  });

  return router;
}
