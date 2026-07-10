export interface ParsedLLH {
  latitude: number;
  longitude: number;
  height: number | null;
  /** undefined (not present in the file) is distinct from a rotation of exactly 0 -- the
   * pipeline needs to know whether to warn about a defaulted orientation. */
  rotationDeg?: number;
}

function validateRanges(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error(`invalid LLH: latitude ${latitude} out of range [-90, 90]`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error(`invalid LLH: longitude ${longitude} out of range [-180, 180]`);
  }
}

function parseNumber(raw: string, field: string): number {
  const value = Number(raw.trim());
  if (Number.isNaN(value)) throw new Error(`invalid LLH: ${field} value ${JSON.stringify(raw)} is not a number`);
  return value;
}

const NUMBER_TOKEN = /^-?\d+(\.\d+)?$/;

/**
 * Real-world LLH files (as actually produced alongside an FBX upload) are a single line of
 * 3 whitespace-separated numbers, in Longitude Latitude Height order -- e.g.:
 *   -111.73694444444445 57.32694444444445 0
 * with no "Latitude:"/"Longitude:" labels at all. Detected by: the whole file has no ':'
 * anywhere (ruling out the labeled line format below) and reduces to exactly one non-blank
 * line of exactly 3 numeric tokens. Returns null (not a match) rather than throwing, so
 * parseLLH can fall through to the other formats when this one doesn't apply.
 */
function parseCoordinateTripletShape(text: string): ParsedLLH | null {
  if (text.includes(':')) return null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return null;

  const tokens = lines[0]!.split(/\s+/);
  if (tokens.length !== 3 || !tokens.every((token) => NUMBER_TOKEN.test(token))) return null;

  const [lonRaw, latRaw, heightRaw] = tokens as [string, string, string];
  const longitude = Number(lonRaw);
  const latitude = Number(latRaw);
  const height = Number(heightRaw);
  validateRanges(latitude, longitude);

  return { latitude, longitude, height, rotationDeg: undefined };
}

/** JSON-equivalent shape: { latitude, longitude, height?, rotation? } (case-insensitive
 * keys tolerated by lowercasing before lookup). */
function parseJsonShape(text: string): ParsedLLH {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('invalid LLH: JSON input must be an object');
  }
  const lower = new Map(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v]));

  const latRaw = lower.get('latitude') ?? lower.get('lat');
  const lonRaw = lower.get('longitude') ?? lower.get('lon');
  if (typeof latRaw !== 'number' || typeof lonRaw !== 'number') {
    throw new Error('invalid LLH: JSON input requires numeric latitude and longitude');
  }
  validateRanges(latRaw, lonRaw);

  const heightRaw = lower.get('height');
  const rotationRaw = lower.get('rotation') ?? lower.get('rotationdeg');

  return {
    latitude: latRaw,
    longitude: lonRaw,
    height: typeof heightRaw === 'number' ? heightRaw : null,
    rotationDeg: typeof rotationRaw === 'number' ? rotationRaw : undefined,
  };
}

/** "Latitude:/Longitude:/Height:" line format, case- and whitespace-tolerant, with an
 * optional "Rotation:" line. */
function parseLineShape(text: string): ParsedLLH {
  const fields = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    fields.set(key, value);
  }

  const latRaw = fields.get('latitude') ?? fields.get('lat');
  const lonRaw = fields.get('longitude') ?? fields.get('lon');
  if (latRaw === undefined || lonRaw === undefined) {
    throw new Error('invalid LLH: missing required Latitude/Longitude line(s)');
  }
  const latitude = parseNumber(latRaw, 'Latitude');
  const longitude = parseNumber(lonRaw, 'Longitude');
  validateRanges(latitude, longitude);

  const heightRaw = fields.get('height');
  const rotationRaw = fields.get('rotation');

  return {
    latitude,
    longitude,
    height: heightRaw !== undefined ? parseNumber(heightRaw, 'Height') : null,
    rotationDeg: rotationRaw !== undefined ? parseNumber(rotationRaw, 'Rotation') : undefined,
  };
}

/** Parses an LLH anchor file: the real-world bare "Longitude Latitude Height" single-line
 * triplet, the "Latitude:/Longitude:/Height:[/Rotation:]" labeled line format, or an
 * equivalent flat JSON object. Throws with a descriptive message on malformed input or
 * out-of-range coordinates. */
export function parseLLH(text: string): ParsedLLH {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return parseJsonShape(trimmed);

  const triplet = parseCoordinateTripletShape(trimmed);
  if (triplet) return triplet;

  return parseLineShape(trimmed);
}
