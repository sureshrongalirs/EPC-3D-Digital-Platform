/**
 * Read helper for TEXT-JSON columns (and Postgres jsonb columns, which the `pg` driver
 * already returns pre-parsed): if the driver handed back a string, parse it; if it's
 * already an object/array (pg jsonb, or null), pass it through. This one function is
 * correct for both dialects without a dialect check.
 */
export function parseJsonColumn<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/** Write helper: always send a JSON string — Postgres implicitly casts text to jsonb. */
export function serializeJsonColumn(value: unknown): string {
  return JSON.stringify(value);
}

export type Bbox = [number, number, number];

export function parseBbox(value: unknown): Bbox | null {
  return parseJsonColumn<Bbox>(value);
}

export function serializeBbox(value: Bbox | null | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}
