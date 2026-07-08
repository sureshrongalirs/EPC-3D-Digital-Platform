import fsp from 'node:fs/promises';
import path from 'node:path';

import type { SourceFileRef } from '@plantscope/server-shared';

import type { ConvertContext, ConvertResult, FormatAdapter, ProbeReport } from '../types.js';
import { ingestMdb2 } from './ingest.js';
import { isMdbToolsAvailable } from './mdbtools.js';

/** Metadata-only adapter: joins and bulk-inserts engineering properties into `components`
 * (see ingest.ts) but never produces a renderable artifact -- geometry comes from the FBX
 * adapter when both are present in a model's sourceFiles (auto-pairing happens in
 * pipeline.ts, not here). */
export const mdb2Adapter: FormatAdapter = {
  id: 'mdb2',

  async sniff(absolutePath) {
    const ext = path.extname(absolutePath).toLowerCase();
    return ext === '.mdb2' || ext === '.mdb';
  },

  async probe(absolutePath): Promise<ProbeReport> {
    const stat = await fsp.stat(absolutePath);
    const sizeMB = stat.size / (1024 * 1024);
    // mdbtools streams the large `labels` table but still holds the per-object join result
    // (and the small lookup tables) in memory; empirically a fraction of source file size.
    return { estimatedPeakMemoryMB: Math.max(50, sizeMB * 0.5), estimatedSizeMB: 0, warnings: [] };
  },

  async convert(ctx: ConvertContext, sourceFile: SourceFileRef & { absolutePath: string }): Promise<ConvertResult> {
    if (!(await isMdbToolsAvailable())) {
      throw new Error('mdbtools (mdb-export/mdb-tables) is not installed in this environment');
    }

    const largeJob = (await this.probe(sourceFile.absolutePath)).estimatedPeakMemoryMB >= 250;
    const { objectCount, warnings } = await ingestMdb2(sourceFile.absolutePath, ctx.db, ctx.modelId, ctx.revision, {
      exclusiveAccess: largeJob,
    });

    return { warnings: [...warnings, `mdb2: ingested ${objectCount} component(s)`] };
  },
};
