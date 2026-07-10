import type { Interface as ReadlineInterface } from 'node:readline';

/** Minimal RFC4180-ish CSV line splitter -- handles double-quoted fields (with "" as an
 * escaped quote) and embedded commas, which is what `mdb-export`'s default CSV output uses.
 * Not a full CSV parser (no embedded newlines inside quoted fields); mdb-export doesn't
 * produce those for the flat lookup/label tables this worker reads. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Streams a `mdb-export`-shaped CSV (header row + data rows) as objects keyed by header
 * column name, one row at a time -- the caller decides whether to accumulate (small lookup
 * tables) or fold into a running aggregate (the large `labels` table), so this function
 * itself never buffers more than one row. */
export async function* streamCsvRows(lines: ReadlineInterface | AsyncIterable<string>): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  for await (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) continue;
    const fields = splitCsvLine(line);
    if (header === null) {
      header = fields;
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((col, i) => {
      row[col] = fields[i] ?? '';
    });
    yield row;
  }
}
