/**
 * Task 2: encodes a node's full hierarchy path (root-to-node names, e.g.
 * `['Building_0', 'Floor_0', 'Room_0', 'Valve']`) into a deterministic, filesystem-safe
 * filename. Pure function, no I/O -- the encoding is one-way (metadata.json carries the real
 * path array separately as the authoritative source; nothing ever needs to decode a path back
 * out of a filename).
 *
 * Identity is the full path, not the bare node name, because node names are not unique within
 * a model (generateHierarchyFixture's own test fixture deliberately reuses "Room_0" under
 * every Floor, and leaf type names under every Room) -- see
 * docs/phase5r/task2-kickoff-amendment.md. On a flat tree (every real client file inspected so
 * far: RootNode -> N leaves, zero intermediate groups) the path degrades to a short 1-2-segment
 * encoding naturally, with no special-casing required.
 */

const SEGMENT_SEPARATOR = '__';
const UNSAFE_CHAR = /[^A-Za-z0-9_.-]/g;
const REPEATED_UNDERSCORE = /_{2,}/g;

function sanitizeSegment(segment: string): string {
  const replaced = segment.replace(UNSAFE_CHAR, '_').replace(REPEATED_UNDERSCORE, '_');
  const trimmed = replaced.replace(/^_+/, '').replace(/_+$/, '');
  return trimmed.length > 0 ? trimmed : '_';
}

/**
 * Tracks how many times each encoded base name has been produced during one deterministic
 * (depth-first, document-order) traversal, so `encodeObjectFilename` can append a stable
 * ordinal on collision. Keyed on the LOWERCASED base name: Windows (NTFS default config) and
 * macOS (HFS+/APFS default config) both treat filenames case-insensitively, so two paths that
 * only differ by case (e.g. "Room_0" vs "room_0" after sanitization) are just as much a real
 * collision as an exact match, and must both get ordinals rather than silently overwriting
 * each other on those filesystems.
 */
export type CollisionTracker = Map<string, number>;

export function createCollisionTracker(): CollisionTracker {
  return new Map();
}

/**
 * Encodes `path` into a `<encoded>.glb` filename, guaranteed unique against every other path
 * encoded via the same `tracker` instance so far. First occurrence of a given encoded base
 * gets no suffix (the common case stays readable); each subsequent collision on the same
 * (lowercased) base gets `-2`, `-3`, ... appended before the extension, assigned in traversal
 * order -- deterministic and reproducible across repeated runs on identical input, since
 * callers are expected to walk the source tree in a fixed (depth-first, document) order.
 */
export function encodeObjectFilename(path: readonly string[], tracker: CollisionTracker): string {
  const base = path.map(sanitizeSegment).join(SEGMENT_SEPARATOR) || '_';
  const collisionKey = base.toLowerCase();
  const seen = tracker.get(collisionKey) ?? 0;
  tracker.set(collisionKey, seen + 1);
  const suffix = seen === 0 ? '' : `-${seen + 1}`;
  return `${base}${suffix}.glb`;
}
