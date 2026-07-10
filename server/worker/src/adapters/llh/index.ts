import fsp from 'node:fs/promises';
import path from 'node:path';

import type { SourceFileRef } from '@plantscope/server-shared';
import { upsertGeoref } from '@plantscope/server-shared';

import type { ConvertContext, ConvertResult, FormatAdapter, ProbeReport } from '../types.js';
import { parseLLH } from './parse.js';

/** Georef-only adapter: writes a georefs row via the shared upsertGeoref()/resolveRotation()
 * path (CLAUDE.md's Georeferencing invariants) rather than producing a renderable artifact,
 * so the pipeline must not call publishRevision() for this adapter's result. */
export const llhAdapter: FormatAdapter = {
  id: 'llh',

  async sniff(absolutePath) {
    const ext = path.extname(absolutePath).toLowerCase();
    if (ext !== '.llh' && ext !== '.txt') return false;
    try {
      const text = await fsp.readFile(absolutePath, 'utf8');
      parseLLH(text);
      return true;
    } catch {
      return false;
    }
  },

  async probe(): Promise<ProbeReport> {
    return { estimatedPeakMemoryMB: 1, estimatedSizeMB: 0, warnings: [] };
  },

  async convert(ctx: ConvertContext, sourceFile: SourceFileRef & { absolutePath: string }): Promise<ConvertResult> {
    const text = await fsp.readFile(sourceFile.absolutePath, 'utf8');
    const parsed = parseLLH(text);

    const warnings: string[] = [];
    if (parsed.rotationDeg === undefined) {
      warnings.push('orientation defaulted -- refine via Map tool or set a site rotation if one exists.');
    }

    await upsertGeoref(ctx.db, ctx.modelId, ctx.siteId, ctx.revision, {
      anchorLat: parsed.latitude,
      anchorLon: parsed.longitude,
      height: parsed.height,
      // height_datum stays 'unknown' unless the LLH file states one explicitly -- this
      // format has no datum field, so it is never passed here.
      rotationDeg: parsed.rotationDeg ?? null,
      method: 'provided',
    });

    return { warnings };
  },
};
