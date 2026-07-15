import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mocked so this test runs everywhere (no real assimp/mago needed) and stays a pure routing
// regression guard: the only thing under test is fbxAdapter.convert()'s size-routing decision
// (CLAUDE.md invariant #4), not real FBX/GLB conversion.
vi.mock('./assimp.js', () => ({
  isAssimpAvailable: vi.fn().mockResolvedValue(true),
  assimpExport: vi.fn(async (_input: string, output: string) => {
    await fsp.writeFile(output, Buffer.from([0]));
  }),
  assimpFaceCount: vi.fn().mockResolvedValue(1), // identical both calls -> never trips the mismatch check
}));
vi.mock('./linkage.js', () => ({
  parseFBXLinkages: vi.fn().mockReturnValue(new Map()),
}));
vi.mock('../tiles/index.js', () => ({
  tileGlb: vi.fn(),
}));

import { fbxAdapter } from './index.js';
import { tileGlb } from '../tiles/index.js';
import type { ConvertContext } from '../types.js';

const mockedTileGlb = vi.mocked(tileGlb);

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-fbx-routing-'));
}

describe('fbxAdapter.convert() size routing (CLAUDE.md invariant #4)', () => {
  afterEach(() => {
    mockedTileGlb.mockReset();
  });

  it('a source at or under sizeThresholdMb never invokes tileGlb() (and therefore never invokes the splitter, which lives entirely inside tileGlb())', async () => {
    const dir = await makeTempDir();
    try {
      const sourcePath = path.join(dir, 'model.fbx');
      await fsp.writeFile(sourcePath, Buffer.alloc(1024)); // 1KB, far under any real threshold

      const ctx: ConvertContext = {
        db: {} as ConvertContext['db'],
        modelId: 'm1',
        siteId: null,
        revision: 1,
        sourceFiles: [],
        outDir: path.join(dir, 'out'),
        dataDir: dir,
        dracoForCesium: false,
        sizeThresholdMb: 50,
        splitterTriangleFloor: 50,
        splitterBlobWarnRatio: 0.5,
      };

      const result = await fbxAdapter.convert(ctx, { kind: 'fbx', path: 'x', originalName: 'model.fbx', absolutePath: sourcePath });

      expect(mockedTileGlb).not.toHaveBeenCalled();
      expect(result.artifact?.artifactType).toBe('glb');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('a source strictly over sizeThresholdMb does invoke tileGlb() -- confirms the spy itself is wired correctly (contrast case)', async () => {
    const dir = await makeTempDir();
    try {
      const sourcePath = path.join(dir, 'model.fbx');
      await fsp.writeFile(sourcePath, Buffer.alloc(1024));

      mockedTileGlb.mockResolvedValue({ tilesetPath: path.join(dir, 'tileset.json'), metadataPath: path.join(dir, 'metadata.json'), warnings: [] });

      const ctx: ConvertContext = {
        db: {} as ConvertContext['db'],
        modelId: 'm1',
        siteId: null,
        revision: 1,
        sourceFiles: [],
        outDir: path.join(dir, 'out'),
        dataDir: dir,
        dracoForCesium: false,
        sizeThresholdMb: 0, // 1KB source > 0MB threshold
        splitterTriangleFloor: 50,
        splitterBlobWarnRatio: 0.5,
      };

      const result = await fbxAdapter.convert(ctx, { kind: 'fbx', path: 'x', originalName: 'model.fbx', absolutePath: sourcePath });

      expect(mockedTileGlb).toHaveBeenCalledTimes(1);
      expect(result.artifact?.artifactType).toBe('tiles');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
