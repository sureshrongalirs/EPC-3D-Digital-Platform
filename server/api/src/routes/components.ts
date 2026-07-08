import { Router } from 'express';

import type { Database } from '../db/index.js';
import { badRequest, notFound } from '../lib/problem.js';
import { getComponent, toComponentDto } from '../repo/components.js';

export function createComponentsRouter(db: Database): Router {
  const router = Router();

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
