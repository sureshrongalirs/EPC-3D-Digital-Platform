import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';

import type { Database, SourceFileRef } from '@plantscope/server-shared';
import {
  createModel,
  deleteModel,
  getModelRow,
  listModelRows,
  publishRevision,
  recordAudit,
  toModelDtoWithArtifact,
} from '@plantscope/server-shared';

import type { Config } from '../config.js';
import { badRequest, notFound } from '../lib/problem.js';
import { createUploadMiddleware, groupBatchFiles, validateUploadedFile, type UploadedFile } from '../lib/upload.js';

function toRelativePath(dataDir: string, absolutePath: string): string {
  return path.relative(dataDir, absolutePath).split(path.sep).join('/');
}

function fileKindFor(originalName: string): SourceFileRef['kind'] {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.fbx') return 'fbx';
  if (ext === '.mdb2' || ext === '.mdb') return 'mdb2';
  if (ext === '.llh' || ext === '.txt') return 'llh';
  return 'other';
}

/** Moves a validated temp upload into its permanent home under DATA_DIR/models/raw/<modelId>/. */
async function commitUpload(config: Config, modelId: string, file: UploadedFile): Promise<SourceFileRef> {
  const destDir = path.join(config.modelsRawDir, modelId);
  await fsp.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, path.basename(file.originalname));
  await fsp.rename(file.path, destPath);
  return { kind: fileKindFor(file.originalname), path: toRelativePath(config.dataDir, destPath), originalName: file.originalname };
}

export function createModelsRouter(db: Database, config: Config): Router {
  const router = Router();
  const upload = createUploadMiddleware(config.modelsRawDir, config.maxUploadBytes);

  // POST /api/models — single multipart upload.
  router.post('/models', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('missing "file" field');

    const kind = await validateUploadedFile(file.originalname, file.path);
    const modelId = crypto.randomUUID();
    const sourceFile = await commitUpload(config, modelId, file);

    const siteId = typeof req.body?.siteId === 'string' && req.body.siteId ? req.body.siteId : null;
    await createModel(db, {
      id: modelId,
      name: path.parse(file.originalname).name,
      sourceFormat: kind,
      sizeBytes: file.size,
      sourceFiles: [sourceFile],
      siteId,
    });
    await recordAudit(db, { action: 'model.upload', subject: modelId, detail: { originalName: file.originalname } });

    // Already-ready formats (a GLB is directly renderable) can self-publish immediately —
    // there's nothing for the Phase 4 worker to convert.
    if (kind === 'glb') {
      await publishRevision(db, { modelId, revision: 1, artifactType: 'glb', artifactPath: sourceFile.path });
    }

    const dto = await toModelDtoWithArtifact(db, (await getModelRow(db, modelId))!);
    res.status(201).json(dto);
  });

  // POST /api/models/batch — file GROUPS (fbx + optional mdb2 + optional llh), one queued
  // row per group, not per file.
  router.post('/models/batch', upload.array('files'), async (req, res) => {
    const files = (req.files as UploadedFile[] | undefined) ?? [];
    if (files.length === 0) throw badRequest('missing "files" field(s)');

    const groups = groupBatchFiles(files, req.body?.groupIds);
    const created: unknown[] = [];

    for (const [groupKey, groupFiles] of groups) {
      const kinds = await Promise.all(groupFiles.map((f) => validateUploadedFile(f.originalname, f.path)));
      const modelId = crypto.randomUUID();
      const sourceFiles = await Promise.all(groupFiles.map((f) => commitUpload(config, modelId, f)));
      const totalSize = groupFiles.reduce((sum, f) => sum + f.size, 0);
      const primaryKind = kinds.includes('fbx') ? 'fbx' : (kinds[0] ?? 'unknown');

      const row = await createModel(db, {
        id: modelId,
        name: groupKey,
        sourceFormat: primaryKind,
        sizeBytes: totalSize,
        sourceFiles,
      });
      await recordAudit(db, { action: 'model.upload.batch', subject: modelId, detail: { groupKey, files: sourceFiles } });
      created.push(await toModelDtoWithArtifact(db, row));
    }

    res.status(201).json(created);
  });

  // GET /api/models — newest first.
  router.get('/models', async (_req, res) => {
    const rows = await listModelRows(db);
    res.json(await Promise.all(rows.map((row) => toModelDtoWithArtifact(db, row))));
  });

  // GET /api/models/{id}
  router.get('/models/:id', async (req, res) => {
    const row = await getModelRow(db, req.params.id);
    if (!row) throw notFound(`model ${req.params.id} not found`);
    res.json(await toModelDtoWithArtifact(db, row));
  });

  // DELETE /api/models/{id} — remove files + rows.
  router.delete('/models/:id', async (req, res) => {
    const row = await getModelRow(db, req.params.id);
    if (!row) throw notFound(`model ${req.params.id} not found`);

    await fsp.rm(path.join(config.modelsRawDir, row.id), { recursive: true, force: true });
    await fsp.rm(path.join(config.modelsArtifactsDir, row.id), { recursive: true, force: true });
    await deleteModel(db, row.id);
    await recordAudit(db, { action: 'model.delete', subject: row.id });

    res.status(204).send();
  });

  return router;
}
