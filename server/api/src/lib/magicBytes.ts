export type FileKind = 'zip' | 'fbx' | 'glb' | 'access' | 'llh-text' | 'unknown';

const ZIP_MAGIC = [0x50, 0x4b]; // "PK" — covers both local-file (03 04) and empty-archive (05 06) records
const FBX_MAGIC = 'Kaydara FBX Binary';
const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46]; // "glTF"
// Microsoft Jet/ACE (Access) databases carry this ASCII marker a few bytes into the header.
const ACCESS_MARKERS = ['Standard Jet DB', 'Standard ACE DB'];

function startsWithBytes(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, i) => buffer[i] === byte);
}

function containsAscii(buffer: Buffer, marker: string, withinBytes: number): boolean {
  return buffer.subarray(0, withinBytes).includes(Buffer.from(marker, 'ascii'));
}

/** Is this buffer plausibly text (no NUL bytes, mostly printable/whitespace ASCII)? */
function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length === 0) return true;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) return false; // NUL byte — never appears in legitimate text
    const isPrintable = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f);
    if (isPrintable) printable += 1;
  }
  return printable / sample.length > 0.95;
}

/** Sniffs a file's actual kind from its bytes — never trust the filename/extension alone. */
export function detectFileKind(buffer: Buffer): FileKind {
  if (startsWithBytes(buffer, ZIP_MAGIC)) return 'zip';
  if (containsAscii(buffer, FBX_MAGIC, 32)) return 'fbx';
  if (startsWithBytes(buffer, GLB_MAGIC)) return 'glb';
  if (ACCESS_MARKERS.some((marker) => containsAscii(buffer, marker, 64))) return 'access';
  if (looksLikeText(buffer)) return 'llh-text';
  return 'unknown';
}

const EXTENSION_KIND: Record<string, FileKind[]> = {
  '.fbx': ['fbx'],
  '.glb': ['glb'],
  '.mdb2': ['access'],
  '.mdb': ['access'],
  '.llh': ['llh-text'],
  '.txt': ['llh-text'],
  '.zip': ['zip'],
};

export function expectedKindsForExtension(filename: string): FileKind[] | null {
  const match = /\.[^.]+$/.exec(filename.toLowerCase());
  if (!match) return null;
  return EXTENSION_KIND[match[0]] ?? null;
}

export interface SniffResult {
  kind: FileKind;
  ok: boolean;
}

/** Rejects an extension/content mismatch (e.g. a `.fbx`-named plain-text file). */
export function sniffAndValidate(filename: string, buffer: Buffer): SniffResult {
  const kind = detectFileKind(buffer);
  const expected = expectedKindsForExtension(filename);
  if (!expected) return { kind, ok: false };
  return { kind, ok: expected.includes(kind) };
}
