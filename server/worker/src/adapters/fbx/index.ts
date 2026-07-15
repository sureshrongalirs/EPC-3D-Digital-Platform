import fsp from 'node:fs/promises';
import path from 'node:path';

import type { SourceFileRef } from '@plantscope/server-shared';

import type { ConvertContext, ConvertResult, FormatAdapter, ProbeReport } from '../types.js';
import { tileGlb } from '../tiles/index.js';
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

  /**
   * Size routing (CLAUDE.md invariant #4): the source FBX's own size decides GLB vs. OGC 3D
   * Tiles -- both branches share the same assimp export step below, only what happens to the
   * resulting intermediate GLB differs. A source at exactly sizeThresholdMb still goes to
   * GLB ("≤" means GLB, only strictly-greater routes to tiles).
   */
  async convert(ctx: ConvertContext, sourceFile: SourceFileRef & { absolutePath: string }): Promise<ConvertResult> {
    if (!(await isAssimpAvailable())) {
      throw new Error('assimp is not installed in this environment');
    }

    const warnings: string[] = [];
    await fsp.mkdir(ctx.outDir, { recursive: true });
    const rawGlbPath = path.join(ctx.outDir, 'model.raw.glb');

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

    const fbxBuffer = await fsp.readFile(sourceFile.absolutePath);
    const linkageMap = parseFBXLinkages(fbxBuffer);
    if (linkageMap.size === 0) {
      warnings.push('no Linkages properties recovered from this FBX (Properties70 scan found none)');
    }

    const sourceStat = await fsp.stat(sourceFile.absolutePath);
    const sourceSizeMB = sourceStat.size / (1024 * 1024);

    if (sourceSizeMB > ctx.sizeThresholdMb) {
      // Identity preservation for tiles (Task 2): tileGlb() -> splitter.ts explodes the
      // merged GLB into one file per object and looks up each object's linkage key directly
      // in this same linkageMap, matched by node NAME -- not derived from mago-3d-tiler's own
      // output at all (mago never sees or produces linkage information; it only sees the
      // already-split GLBs splitter.ts hands it). This is safe because assimp preserves FBX
      // Model node names exactly, 1:1, through to the exported GLB's own node names (confirmed
      // against a real client file, docs/phase5r/task2-kickoff-amendment.md) -- the same
      // parseFBXLinkages() call above already produced this map keyed by that same name.
      const tilingResult = await tileGlb(rawGlbPath, ctx.outDir, linkageMap, {
        triangleFloor: ctx.splitterTriangleFloor,
        blobWarnRatio: ctx.splitterBlobWarnRatio,
      });
      warnings.push(...tilingResult.warnings);

      return {
        artifact: {
          artifactType: 'tiles',
          artifactPath: path.relative(ctx.dataDir, tilingResult.tilesetPath).split(path.sep).join('/'),
        },
        linkageMap,
        warnings,
      };
    }

    const finalGlbPath = path.join(ctx.outDir, 'model.glb');
    if (ctx.dracoForCesium) {
      await compressWithDraco(rawGlbPath, finalGlbPath);
      await fsp.rm(rawGlbPath, { force: true });
    } else {
      // Default: skip Draco entirely (see Config.dracoForCesium's doc comment) -- Cesium's
      // built-in decoder hangs silently on this encoder's output, so an uncompressed GLB is
      // what actually renders. assimp already wrote the exported GLB to rawGlbPath; just
      // rename it into place rather than a redundant read+write copy.
      await fsp.rename(rawGlbPath, finalGlbPath);
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
