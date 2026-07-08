import fsp from 'node:fs/promises';
import path from 'node:path';

import type { SourceFileRef } from '@plantscope/server-shared';

import type { ConvertContext, ConvertResult, FormatAdapter, ProbeReport } from '../types.js';
import { assimpExport, assimpFaceCount, isAssimpAvailable } from './assimp.js';
import { looksLikeFBXBinary } from './binaryReader.js';
import { compressWithDraco } from './draco.js';
import { parseFBXLinkages } from './linkage.js';

export const fbxAdapter: FormatAdapter = {
  id: 'fbx',

  async sniff(absolutePath) {
    const fh = await fsp.open(absolutePath, 'r');
    try {
      const buf = Buffer.alloc(21);
      await fh.read(buf, 0, 21, 0);
      return looksLikeFBXBinary(buf);
    } finally {
      await fh.close();
    }
  },

  async probe(absolutePath): Promise<ProbeReport> {
    const stat = await fsp.stat(absolutePath);
    const sizeMB = stat.size / (1024 * 1024);
    // assimp's in-memory scene graph plus our own buffered parse of the raw node tree; a
    // conservative multiple of source size, refined by real numbers once verify-local.sh has
    // been run against actual client files (see this task's report).
    return { estimatedPeakMemoryMB: sizeMB * 4, estimatedSizeMB: sizeMB, warnings: [] };
  },

  async convert(ctx: ConvertContext, sourceFile: SourceFileRef & { absolutePath: string }): Promise<ConvertResult> {
    if (!(await isAssimpAvailable())) {
      throw new Error('assimp is not installed in this environment');
    }

    const warnings: string[] = [];
    await fsp.mkdir(ctx.outDir, { recursive: true });
    const rawGlbPath = path.join(ctx.outDir, 'model.raw.glb');
    const finalGlbPath = path.join(ctx.outDir, 'model.glb');

    await assimpExport(sourceFile.absolutePath, rawGlbPath);

    const [facesIn, facesOut] = await Promise.all([
      assimpFaceCount(sourceFile.absolutePath),
      assimpFaceCount(rawGlbPath),
    ]);
    if (facesIn !== facesOut) {
      throw new Error(
        `triangle count mismatch after FBX->GLB conversion: source has ${facesIn} faces, exported GLB has ${facesOut}`,
      );
    }

    await compressWithDraco(rawGlbPath, finalGlbPath);
    await fsp.rm(rawGlbPath, { force: true });

    const fbxBuffer = await fsp.readFile(sourceFile.absolutePath);
    const linkageMap = parseFBXLinkages(fbxBuffer);
    if (linkageMap.size === 0) {
      warnings.push('no Linkages properties recovered from this FBX (Properties70 scan found none)');
    }

    return {
      artifact: {
        artifactType: 'glb',
        artifactPath: path.relative(ctx.dataDir, finalGlbPath).split(path.sep).join('/'),
      },
      linkageMap,
      warnings,
    };
  },
};
