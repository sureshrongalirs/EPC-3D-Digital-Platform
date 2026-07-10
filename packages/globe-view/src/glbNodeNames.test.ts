import { describe, expect, it } from 'vitest';

import { parseGlbNodeNames } from './glbNodeNames.js';

/** Builds a minimal valid GLB with only a JSON chunk (no binary chunk needed --
 * parseGlbNodeNames never reads past the JSON chunk). */
function buildGlb(json: unknown): ArrayBuffer {
  const jsonText = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonText);
  // GLB chunks are 4-byte aligned; pad with trailing spaces (valid whitespace in JSON).
  const padded = jsonBytes.length % 4 === 0 ? jsonBytes : new Uint8Array(jsonBytes.length + (4 - (jsonBytes.length % 4)));
  padded.set(jsonBytes);
  padded.fill(0x20, jsonBytes.length);

  const totalLength = 12 + 8 + padded.length;
  const buf = new ArrayBuffer(totalLength);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x46546c67, true); // magic 'glTF'
  dv.setUint32(4, 2, true); // version
  dv.setUint32(8, totalLength, true);
  dv.setUint32(12, padded.length, true); // chunk length
  dv.setUint32(16, 0x4e4f534a, true); // chunk type 'JSON'
  new Uint8Array(buf, 20).set(padded);
  return buf;
}

describe('parseGlbNodeNames', () => {
  it('extracts every named node from the JSON chunk', () => {
    const buf = buildGlb({ nodes: [{ name: 'Pump-1' }, { name: 'Valve-1' }, { name: 'Tank-1' }] });
    expect(parseGlbNodeNames(buf)).toEqual(['Pump-1', 'Valve-1', 'Tank-1']);
  });

  it('skips nodes with no name rather than throwing', () => {
    const buf = buildGlb({ nodes: [{ name: 'Pump-1' }, {}, { name: 'Tank-1' }] });
    expect(parseGlbNodeNames(buf)).toEqual(['Pump-1', 'Tank-1']);
  });

  it('returns an empty array when there are no nodes at all', () => {
    const buf = buildGlb({ nodes: [] });
    expect(parseGlbNodeNames(buf)).toEqual([]);
  });

  it('returns an empty array for a buffer with no glTF magic header', () => {
    const buf = new ArrayBuffer(32);
    expect(parseGlbNodeNames(buf)).toEqual([]);
  });

  it('returns an empty array for a truncated/too-short buffer instead of throwing', () => {
    const buf = new ArrayBuffer(4);
    expect(parseGlbNodeNames(buf)).toEqual([]);
  });
});
