import fsp from 'node:fs/promises';
import path from 'node:path';

import type { SourceFileRef } from '@plantscope/server-shared';

import type { ConvertContext, ConvertResult, FormatAdapter, ProbeReport } from './types.js';

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian uint32

/** GLB is already the artifact format (CLAUDE.md invariant #4's target for small models),
 * so this adapter is a pure copy into the revision's artifact directory -- no assimp, no
 * Draco re-compression (a source GLB is trusted to already be appropriately compressed). */
export const glbAdapter: FormatAdapter = {
  id: 'glb',

  async sniff(absolutePath) {
    const fh = await fsp.open(absolutePath, 'r');
    try {
      const buf = Buffer.alloc(4);
      await fh.read(buf, 0, 4, 0);
      return buf.readUInt32LE(0) === GLB_MAGIC;
    } finally {
      await fh.close();
    }
  },

  async probe(absolutePath): Promise<ProbeReport> {
    const stat = await fsp.stat(absolutePath);
    const sizeMB = stat.size / (1024 * 1024);
    return { estimatedPeakMemoryMB: sizeMB * 2, estimatedSizeMB: sizeMB, warnings: [] };
  },

  async convert(ctx: ConvertContext, sourceFile: SourceFileRef & { absolutePath: string }): Promise<ConvertResult> {
    const destPath = path.join(ctx.outDir, 'model.glb');
    await fsp.mkdir(ctx.outDir, { recursive: true });
    await fsp.copyFile(sourceFile.absolutePath, destPath);

    return {
      artifact: { artifactType: 'glb', artifactPath: path.relative(ctx.dataDir, destPath).split(path.sep).join('/') },
      warnings: [],
    };
  },
};
