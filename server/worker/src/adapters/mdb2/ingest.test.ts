import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { streamCsvRows } from './csv.js';
import { Mdb2JoinAccumulator, type LabelNameRow, type LabelRow, type LabelValueRow, type LinkageRow } from './join.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// testdata/scripts/generate-mdb2-labels-fixture.mjs writes a synthetic, oversized CSV set
// mimicking mdb-export output -- generated fresh here (via a dynamic, non-literal import
// specifier so tsc's rootDir check doesn't try to resolve it at compile time) rather than
// committed, since it's large and fully reproducible (CLAUDE.md invariant #8's spirit).
const generatorPath = path.resolve(here, '..', '..', '..', '..', '..', 'testdata', 'scripts', 'generate-mdb2-labels-fixture.mjs');

async function loadRowsAsMap<T>(csvPath: string, key: string): Promise<Map<string, T>> {
  const rl = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  const map = new Map<string, T>();
  for await (const row of streamCsvRows(rl)) {
    map.set(row[key]!, row as unknown as T);
  }
  return map;
}

describe('mdb2 streaming join at scale (500k+ label rows)', () => {
  it('joins 500,000 label rows across 1,000 objects within a time and memory budget', async () => {
    const generatorModule = (await import(pathToFileURL(generatorPath).href)) as {
      generateMdb2LabelsFixture: (
        outDir: string,
        objectCount?: number,
        labelsPerObject?: number,
      ) => Promise<{ objectCount: number; labelsPerObject: number; totalLabels: number }>;
    };

    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plantscope-mdb2-fixture-'));
    try {
      const { objectCount, totalLabels } = await generatorModule.generateMdb2LabelsFixture(outDir, 1000, 500);
      expect(totalLabels).toBeGreaterThanOrEqual(500_000);

      const linkageById = (await loadRowsAsMap<LinkageRow>(path.join(outDir, 'linkage.csv'), 'linkage_id')) as unknown as Map<
        string,
        LinkageRow
      >;
      const labelNameRows = await loadRowsAsMap<LabelNameRow>(path.join(outDir, 'label_names.csv'), 'label_name_id');
      const labelValueRows = await loadRowsAsMap<LabelValueRow>(path.join(outDir, 'label_values.csv'), 'label_value_id');
      const labelNameById = new Map([...labelNameRows.values()].map((r) => [r.label_name_id, r.name]));
      const labelValueById = new Map([...labelValueRows.values()].map((r) => [r.label_value_id, r.value]));

      const acc = new Mdb2JoinAccumulator(linkageById, labelNameById, labelValueById);

      const rssSamplesMB: number[] = [];
      const startedAt = Date.now();
      let rowsSeen = 0;

      const rl = createInterface({ input: createReadStream(path.join(outDir, 'labels.csv')), crlfDelay: Infinity });
      for await (const row of streamCsvRows(rl)) {
        acc.addLabel(row as unknown as LabelRow);
        rowsSeen += 1;
        if (rowsSeen % 50_000 === 0) {
          rssSamplesMB.push(process.memoryUsage().rss / (1024 * 1024));
        }
      }
      acc.includeAllLinkages();

      const elapsedMs = Date.now() - startedAt;

      expect(rowsSeen).toBe(totalLabels);
      expect(acc.size).toBe(objectCount);

      // Time budget: streaming + folding 500k rows should be well under a minute even on a
      // slow CI runner. This is intentionally generous -- the point is to catch an
      // accidental O(n^2) regression, not to pin exact throughput.
      expect(elapsedMs).toBeLessThan(60_000);

      // Memory budget: RSS should stay roughly flat across the run (bounded by the number of
      // *distinct objects*, not the number of label rows) -- if it grew linearly with rows
      // seen, the last sample would dwarf the first.
      expect(rssSamplesMB.length).toBeGreaterThan(1);
      const first = rssSamplesMB[0]!;
      const last = rssSamplesMB[rssSamplesMB.length - 1]!;
      expect(last).toBeLessThan(first + 300); // generous absolute headroom, not a tight ratio
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
