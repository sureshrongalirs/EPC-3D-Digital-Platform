// Generates a synthetic, oversized mdb-export-shaped CSV fixture set (linkage.csv,
// label_names.csv, label_values.csv, labels.csv) used to load-test server/worker's mdb2
// streaming join (see server/worker/src/adapters/mdb2/ingest.test.ts) against something
// close in scale to the 800MB+ .mdb2 files CLAUDE.md invariant #4 calls out. Deliberately
// NOT committed under testdata/fixtures/ (per CLAUDE.md invariant #8 and this task's "do not
// commit real files" instruction, extended here to "don't commit this either -- it's huge
// and reproducible, not a fixture snapshot) -- run on demand into a scratch directory:
//   node testdata/scripts/generate-mdb2-labels-fixture.mjs <outDir> [objectCount] [labelsPerObject]
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function generateMdb2LabelsFixture(outDir, objectCount = 1000, labelsPerObject = 500) {
  await mkdir(outDir, { recursive: true });

  const labelNameCount = 20;
  const labelValueCount = 2000;

  await writeCsv(path.join(outDir, 'linkage.csv'), ['linkage_id', 'id1', 'id2', 'id3', 'id4', 'moniker', 'category'], function* () {
    for (let i = 0; i < objectCount; i += 1) {
      yield [String(i), '10', '20', String(i % 100), String(i), `Object-${i}`, i % 2 === 0 ? 'Rotating' : 'Static'];
    }
  });

  await writeCsv(path.join(outDir, 'label_names.csv'), ['label_name_id', 'name'], function* () {
    for (let i = 0; i < labelNameCount; i += 1) yield [String(i), `Property-${i}`];
  });

  await writeCsv(path.join(outDir, 'label_values.csv'), ['label_value_id', 'value'], function* () {
    for (let i = 0; i < labelValueCount; i += 1) yield [String(i), `Value-${i}`];
  });

  const totalLabels = objectCount * labelsPerObject;
  await writeCsv(path.join(outDir, 'labels.csv'), ['label_id', 'linkage_id', 'label_name_id', 'label_value_id'], function* () {
    let labelId = 0;
    for (let obj = 0; obj < objectCount; obj += 1) {
      for (let l = 0; l < labelsPerObject; l += 1) {
        const nameId = (obj + l) % labelNameCount;
        const valueId = (obj * 7 + l) % labelValueCount;
        yield [String(labelId), String(obj), String(nameId), String(valueId)];
        labelId += 1;
      }
    }
  });

  return { objectCount, labelsPerObject, totalLabels };
}

function writeCsv(filePath, header, rowsGenerator) {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(filePath);
    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.write(header.join(',') + '\n');
    for (const row of rowsGenerator()) {
      stream.write(row.join(',') + '\n');
    }
    stream.end();
  });
}

async function main() {
  const [outDir, objectCountArg, labelsPerObjectArg] = process.argv.slice(2);
  if (!outDir) {
    console.error('usage: generate-mdb2-labels-fixture.mjs <outDir> [objectCount] [labelsPerObject]');
    process.exitCode = 2;
    return;
  }
  const result = await generateMdb2LabelsFixture(
    outDir,
    objectCountArg ? Number(objectCountArg) : undefined,
    labelsPerObjectArg ? Number(labelsPerObjectArg) : undefined,
  );
  console.log(`wrote ${result.totalLabels} label rows across ${result.objectCount} objects to ${outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
