const GLB_MAGIC = 0x46546c67; // 'glTF', little-endian
const JSON_CHUNK_TYPE = 0x4e4f534a; // 'JSON', little-endian

/**
 * Extracts every named node's name from a GLB buffer's JSON chunk -- nothing more. This
 * deliberately does NOT do a full glTF parse (no accessor/buffer-view/Draco decoding):
 * `Cesium.Model` has no public API to enumerate a loaded model's nodes (only `getNode(name)`,
 * a lookup that requires already knowing the name), so this is how GlobeView's
 * isolate()/showAll() get the full name list to iterate. Node names live in the plain JSON
 * chunk regardless of whether the referenced mesh data is Draco-compressed (our own worker's
 * FBX adapter always Draco-compresses its output -- see server/worker/src/adapters/fbx/draco.ts),
 * so reading just the JSON header is sufficient and avoids needing a Draco decoder here at all.
 */
export function parseGlbNodeNames(buffer: ArrayBuffer): string[] {
  if (buffer.byteLength < 20) return [];

  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== GLB_MAGIC) return [];

  // header (12 bytes: magic, version, total length) + chunk 0 header (8 bytes: chunk
  // length, chunk type) -- chunk 0 is always the JSON chunk per the GLB spec.
  const chunkLength = dv.getUint32(12, true);
  const chunkType = dv.getUint32(16, true);
  if (chunkType !== JSON_CHUNK_TYPE) return [];
  if (20 + chunkLength > buffer.byteLength) return [];

  let json: { nodes?: { name?: unknown }[] };
  try {
    const jsonBytes = new Uint8Array(buffer, 20, chunkLength);
    json = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes)) as { nodes?: { name?: unknown }[] };
  } catch {
    return [];
  }

  return (json.nodes ?? [])
    .map((node) => node.name)
    .filter((name): name is string => typeof name === 'string');
}
