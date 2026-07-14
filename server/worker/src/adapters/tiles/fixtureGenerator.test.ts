import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
// testdata/scripts/generate-plant-grid-fixture.mjs writes synthetic plant-grid GLB(s) used by
// Phase 5R Task 0's mago-3d-tiler re-validation spike -- generated fresh here (via a dynamic,
// non-literal import specifier so tsc's rootDir check doesn't try to resolve it at compile
// time) rather than committed, since production-scale output is large (CLAUDE.md invariant
// #8's spirit). This test only exercises the generator's own correctness at a small,
// fast-to-run scale; the actual >50MB/5,000+-object spike run is a separate manual invocation
// documented in docs/phase5r/task0-findings.md.
const generatorPath = path.resolve(here, '..', '..', '..', '..', '..', 'testdata', 'scripts', 'generate-plant-grid-fixture.mjs');

async function loadGenerator(): Promise<{
  generatePlantGridFixture: (
    outDir: string,
    mode: 'merged' | 'split',
    objectCount?: number,
    segments?: number,
  ) => Promise<{ mode: string; objectCount: number; fileCount: number; totalBytes: number }>;
}> {
  return (await import(pathToFileURL(generatorPath).href)) as Awaited<ReturnType<typeof loadGenerator>>;
}

describe('generatePlantGridFixture', () => {
  it('merged mode writes a single GLB containing one mesh per object', async () => {
    const { generatePlantGridFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-plant-grid-'));
    try {
      const result = await generatePlantGridFixture(outDir, 'merged', 25, 2);
      expect(result.fileCount).toBe(1);
      expect(result.objectCount).toBe(25);

      const files = await fsp.readdir(outDir);
      expect(files).toEqual(['model.glb']);

      const doc = await new NodeIO().read(path.join(outDir, 'model.glb'));
      expect(doc.getRoot().listMeshes()).toHaveLength(25);
      expect(doc.getRoot().listNodes()).toHaveLength(25);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('split mode writes one GLB per object, each with exactly one mesh', async () => {
    const { generatePlantGridFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-plant-grid-'));
    try {
      const result = await generatePlantGridFixture(outDir, 'split', 25, 2);
      expect(result.fileCount).toBe(25);
      expect(result.objectCount).toBe(25);

      const files = (await fsp.readdir(outDir)).sort();
      expect(files).toHaveLength(25);
      expect(files[0]).toBe('Object_00000.glb');
      expect(files[24]).toBe('Object_00024.glb');

      const doc = await new NodeIO().read(path.join(outDir, files[0]!));
      expect(doc.getRoot().listMeshes()).toHaveLength(1);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('denser objects (more segments) produce more bytes for the same object count', async () => {
    const { generatePlantGridFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-plant-grid-'));
    try {
      const sparse = await generatePlantGridFixture(outDir, 'merged', 10, 1);
      const dense = await generatePlantGridFixture(outDir, 'merged', 10, 6);
      expect(dense.totalBytes).toBeGreaterThan(sparse.totalBytes);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown mode', async () => {
    const { generatePlantGridFixture } = await loadGenerator();
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-plant-grid-'));
    try {
      await expect(generatePlantGridFixture(outDir, 'bogus' as 'merged', 5, 1)).rejects.toThrow(/unknown mode/);
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  });
});
