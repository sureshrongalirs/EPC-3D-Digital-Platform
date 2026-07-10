import { describe, expect, it } from 'vitest';

import { parseFBXBinary } from './binaryReader.js';

const MAGIC = Buffer.concat([Buffer.from('Kaydara FBX Binary' + '  ', 'latin1'), Buffer.from([0x00]), Buffer.from([0x1a, 0x00])]);

function encRawInt32Array(values: number[]): Buffer {
  const raw = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => raw.writeInt32LE(v, i * 4));
  const buf = Buffer.alloc(1 + 4 + 4 + 4 + raw.length);
  let o = 0;
  buf.write('i', o, 'latin1');
  o += 1;
  buf.writeUInt32LE(values.length, o);
  o += 4;
  buf.writeUInt32LE(0, o); // encoding = raw (uncompressed) -- this is the path that broke
  o += 4;
  buf.writeUInt32LE(raw.length, o);
  o += 4;
  raw.copy(buf, o);
  return buf;
}

/** Builds a minimal, single-node, version-7400 (32-bit header) FBX binary with one raw
 * (uncompressed) int32 array property, whose payload deliberately starts at a file offset
 * that is NOT a multiple of 4 -- this is the exact condition that crashed parseFBXLinkages
 * with "RangeError: start offset of Int32Array should be a multiple of 4" against a real
 * ~54MB client FBX file (found via scripts/verify-local.sh). The hand-built
 * testdata/fixtures/linkage-fixture.fbx never exercised a *raw* (non-zlib) array, only a
 * compressed one, whose inflateSync() output happens to always land 0-aligned -- which is
 * exactly how this shipped without the earlier fixture catching it. */
function buildBufferWithMisalignedRawArray(): Buffer {
  const version = 7400;
  const nodeName = Buffer.from('N', 'latin1'); // 1 byte -- forces an odd cumulative offset
  const propsBuf = encRawInt32Array([10, 20, 30, 40, 50]);

  const headerSize = 4 + 4 + 4 + 1;
  const endOffset = MAGIC.length + 4 + headerSize + nodeName.length + propsBuf.length + headerSize; // + top sentinel
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(endOffset, 0);
  header.writeUInt32LE(1, 4); // numProperties
  header.writeUInt32LE(propsBuf.length, 8); // propertyListLen
  header.writeUInt8(nodeName.length, 12);

  const versionBuf = Buffer.alloc(4);
  versionBuf.writeUInt32LE(version, 0);

  const topSentinel = Buffer.alloc(headerSize);

  // Sanity-check the very thing this test exists to exercise: the array payload's absolute
  // file offset must not be 4-aligned, or this test would silently stop testing anything.
  const payloadStart = MAGIC.length + versionBuf.length + headerSize + nodeName.length + 1 + 4 + 4 + 4;
  if (payloadStart % 4 === 0) throw new Error('test fixture setup bug: payload offset is 4-aligned, defeats the point of this test');

  return Buffer.concat([MAGIC, versionBuf, header, nodeName, propsBuf, topSentinel]);
}

describe('parseFBXBinary (raw/uncompressed array properties at a non-4-aligned file offset)', () => {
  it('parses a raw int32 array whose payload does not start on a 4-byte boundary', () => {
    const buf = buildBufferWithMisalignedRawArray();
    const doc = parseFBXBinary(buf);

    expect(doc.nodes).toHaveLength(1);
    const values = doc.nodes[0]!.properties[0];
    expect(Array.from(values as Int32Array)).toEqual([10, 20, 30, 40, 50]);
  });
});
