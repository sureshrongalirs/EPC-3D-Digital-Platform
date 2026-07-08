import fsp from 'node:fs/promises';
import path from 'node:path';

import type { Database, ModelRow, SourceFileRef } from '@plantscope/server-shared';
import { publishRevision, serializeJsonColumn } from '@plantscope/server-shared';
import type { Logger } from 'pino';

import { adaptersByKind, extensionStubAdapters, glbAdapter } from './adapters/registry.js';
import type { ConvertContext, ConvertResult, FormatAdapter } from './adapters/types.js';
import { NotImplementedFormatError } from './adapters/types.js';
import type { Config } from './config.js';

export class JobFailure extends Error {}

async function resolveAdapter(absolutePath: string, kind: SourceFileRef['kind']): Promise<FormatAdapter> {
  const byKind = adaptersByKind[kind];
  if (byKind) return byKind;

  if (await glbAdapter.sniff(absolutePath)) return glbAdapter;
  for (const stub of extensionStubAdapters) {
    if (await stub.sniff(absolutePath)) return stub;
  }
  throw new JobFailure(`could not determine a format adapter for ${path.basename(absolutePath)}`);
}

/** Computes what fraction of the FBX-recovered Linkage keys have a matching `components` row
 * (i.e. the mdb2 side actually has engineering data for that physical object) -- below 90%
 * is logged as a job warning, per the task's auto-pairing spec, never a hard failure. */
async function computeJoinCoveragePercent(db: Database, modelId: string, revision: number, linkageMap: Map<string, string>): Promise<number> {
  if (linkageMap.size === 0) return 100;

  const keys = [...new Set(linkageMap.values())];
  const matched = await db
    .knex('components')
    .where({ model_id: modelId, revision })
    .whereIn('linkage_key', keys)
    .countDistinct({ count: 'linkage_key' })
    .first<{ count: string | number } | undefined>();

  const matchedCount = Number(matched?.count ?? 0);
  return Math.round((matchedCount / keys.length) * 100);
}

export interface ProcessJobResult {
  warnings: string[];
}

/**
 * Runs one already-claimed model row's full conversion: resolves an adapter per source
 * file (auto-pairing an fbx + mdb2 pair without a separate mapping step), converts, validates
 * join coverage, writes the linkage-map sidecar, and publishes the resulting revision via the
 * shared publishRevision() (CLAUDE.md invariant #6 -- never reimplemented here).
 *
 * Size routing (CLAUDE.md invariant #4): this only ever produces a GLB. A source large
 * enough that probe() estimates it over config.sizeThresholdMb is refused here with a
 * visible "tiles pipeline arrives in Phase 5" failure, not silently converted or dropped --
 * see fbxAdapter.probe()/glbAdapter.probe() for the estimate this check reads.
 */
export async function processJob(db: Database, config: Config, logger: Logger, model: ModelRow): Promise<ProcessJobResult> {
  const revision = (model.current_revision ?? 0) + 1;
  const outDir = path.join(config.modelsArtifactsDir, model.id, String(revision));
  const sourceFiles: SourceFileRef[] = JSON.parse(model.source_files) as SourceFileRef[];

  if (sourceFiles.length === 0) {
    throw new JobFailure('model has no source files to convert');
  }

  const resolvedFiles = sourceFiles.map((f) => ({ ...f, absolutePath: path.join(config.dataDir, f.path) }));

  const ctx: ConvertContext = {
    db,
    modelId: model.id,
    siteId: model.site_id,
    revision,
    sourceFiles: resolvedFiles,
    outDir,
    dataDir: config.dataDir,
  };

  const warnings: string[] = [];
  let artifact: ConvertResult['artifact'];
  let linkageMap: Map<string, string> | undefined;
  const hasMdb2 = resolvedFiles.some((f) => f.kind === 'mdb2');
  const hasFbx = resolvedFiles.some((f) => f.kind === 'fbx');

  // Geometry (fbx/glb) first, so a subsequent mdb2 pass can be checked for join coverage
  // against the just-recovered linkage map.
  const ordered = [...resolvedFiles].sort((a, b) => (a.kind === 'mdb2' ? 1 : b.kind === 'mdb2' ? -1 : 0));

  for (const sourceFile of ordered) {
    const adapter = await resolveAdapter(sourceFile.absolutePath, sourceFile.kind);

    if (sourceFile.kind === 'fbx' || sourceFile.kind === 'other') {
      const probe = await adapter.probe(sourceFile.absolutePath);
      if (probe.estimatedSizeMB > config.sizeThresholdMb) {
        throw new JobFailure(
          `source exceeds ${config.sizeThresholdMb}MB (estimated ${Math.round(probe.estimatedSizeMB)}MB) -- tiles pipeline arrives in Phase 5`,
        );
      }
    }

    let result: ConvertResult;
    try {
      result = await adapter.convert(ctx, sourceFile);
    } catch (err) {
      if (err instanceof NotImplementedFormatError) throw new JobFailure(err.message);
      throw err;
    }

    warnings.push(...result.warnings);
    if (result.artifact) artifact = result.artifact;
    if (result.linkageMap) linkageMap = result.linkageMap;
  }

  if (hasFbx && hasMdb2 && linkageMap) {
    const coverage = await computeJoinCoveragePercent(db, model.id, revision, linkageMap);
    if (coverage < 90) {
      warnings.push(`fbx/mdb2 join coverage is ${coverage}% (below the 90% expectation)`);
    }
  }

  if (linkageMap && linkageMap.size > 0) {
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(
      path.join(outDir, 'linkage-map.json'),
      JSON.stringify(Object.fromEntries(linkageMap), null, 2),
    );
  }

  if (artifact) {
    await publishRevision(db, {
      modelId: model.id,
      revision,
      artifactType: artifact.artifactType,
      artifactPath: artifact.artifactPath,
    });
  } else {
    // Georef-only (e.g. a lone LLH upload) or metadata-only job: nothing to publish, but the
    // job still completed successfully -- status moves to 'ready' without a new revision.
    await db.knex('models').where({ id: model.id }).update({ status: 'ready' });
  }

  await db
    .knex('models')
    .where({ id: model.id })
    .update({ warnings: warnings.length > 0 ? serializeJsonColumn(warnings) : null });

  logger.info({ modelId: model.id, revision, warnings }, 'job completed');
  return { warnings };
}
