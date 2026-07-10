import { describe, expect, it } from 'vitest';

import { splitCsvLine } from './csv.js';
import { joinMdb2Rows, type LabelNameRow, type LabelRow, type LabelValueRow, type LinkageRow } from './join.js';

// Mimics mdb-export's default CSV output shape for each of the four assumed tables (see
// join.ts's header comment for the schema this ports).
const LINKAGE_CSV = [
  'linkage_id,id1,id2,id3,id4,moniker,category',
  '1,10,20,30,40,Pump-1,Rotating',
  '2,10,20,30,41,Valve-1,Piping',
  '3,10,20,30,42,Tank-1,Static',
].join('\n');

const LABELS_CSV = [
  'label_id,linkage_id,label_name_id,label_value_id',
  '1,1,100,1000',
  '2,1,101,1001',
  '3,2,100,1002',
].join('\n');

const LABEL_NAMES_CSV = ['label_name_id,name', '100,Manufacturer', '101,Model Number'].join('\n');

const LABEL_VALUES_CSV = ['label_value_id,value', '1000,Acme Corp', '1001,XJ-9000', '1002,Beta Inc'].join('\n');

function parseCsv<T>(csv: string): T[] {
  const lines = csv.split('\n');
  const header = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const fields = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((col, i) => (row[col] = fields[i] ?? ''));
    return row as T;
  });
}

describe('joinMdb2Rows (linkage -> labels -> label_names/label_values)', () => {
  it('produces the documented per-object shape: { linkageKey, moniker, category, props }', () => {
    const result = joinMdb2Rows({
      linkage: parseCsv<LinkageRow>(LINKAGE_CSV),
      labels: parseCsv<LabelRow>(LABELS_CSV),
      labelNames: parseCsv<LabelNameRow>(LABEL_NAMES_CSV),
      labelValues: parseCsv<LabelValueRow>(LABEL_VALUES_CSV),
    });

    expect(result).toHaveLength(3);

    const pump = result.find((c) => c.moniker === 'Pump-1');
    expect(pump).toEqual({
      linkageKey: '10-20-30-40',
      moniker: 'Pump-1',
      category: 'Rotating',
      props: { Manufacturer: 'Acme Corp', 'Model Number': 'XJ-9000' },
    });

    const valve = result.find((c) => c.moniker === 'Valve-1');
    expect(valve).toEqual({
      linkageKey: '10-20-30-41',
      moniker: 'Valve-1',
      category: 'Piping',
      props: { Manufacturer: 'Beta Inc' },
    });
  });

  it('includes objects with zero label rows (an object with no properties is still valid)', () => {
    const result = joinMdb2Rows({
      linkage: parseCsv<LinkageRow>(LINKAGE_CSV),
      labels: parseCsv<LabelRow>(LABELS_CSV),
      labelNames: parseCsv<LabelNameRow>(LABEL_NAMES_CSV),
      labelValues: parseCsv<LabelValueRow>(LABEL_VALUES_CSV),
    });

    const tank = result.find((c) => c.moniker === 'Tank-1');
    expect(tank).toEqual({ linkageKey: '10-20-30-42', moniker: 'Tank-1', category: 'Static', props: {} });
  });

  it('drops orphaned label rows referencing an unknown linkage_id', () => {
    const labels = parseCsv<LabelRow>(LABELS_CSV);
    labels.push({ label_id: '99', linkage_id: 'missing', label_name_id: '100', label_value_id: '1000' });

    const result = joinMdb2Rows({
      linkage: parseCsv<LinkageRow>(LINKAGE_CSV),
      labels,
      labelNames: parseCsv<LabelNameRow>(LABEL_NAMES_CSV),
      labelValues: parseCsv<LabelValueRow>(LABEL_VALUES_CSV),
    });

    expect(result).toHaveLength(3); // not 4 -- the orphaned row is dropped, not crashed on
  });
});

describe('splitCsvLine', () => {
  it('splits plain comma-separated fields', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted fields containing commas', () => {
    expect(splitCsvLine('1,"Acme, Corp",3')).toEqual(['1', 'Acme, Corp', '3']);
  });

  it('handles escaped quotes inside quoted fields', () => {
    expect(splitCsvLine('1,"He said ""hi""",3')).toEqual(['1', 'He said "hi"', '3']);
  });
});
