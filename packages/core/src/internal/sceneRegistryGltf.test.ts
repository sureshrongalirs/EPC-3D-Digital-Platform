import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSceneRegistry, type SceneRegistry } from './sceneRegistry';

// Node has no ProgressEvent global; three.js's fetch-based FileLoader constructs one for
// progress callbacks regardless of environment, and does so from a detached internal
// callback — without this, the ReferenceError surfaces as an unhandled rejection and the
// awaited loadAsync()/parse() call just hangs until the test hook times out.
if (typeof globalThis.ProgressEvent === 'undefined') {
  class ProgressEventPolyfill {
    readonly type: string;
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;
    constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
      this.type = type;
      this.lengthComputable = init.lengthComputable ?? false;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  }
  // @ts-expect-error -- minimal polyfill, not a spec-complete ProgressEvent.
  globalThis.ProgressEvent = ProgressEventPolyfill;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '..', '..', '..', '..', 'testdata', 'fixtures');

const CONTENT_TYPES: Record<string, string> = {
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
};

/**
 * Serves testdata/fixtures/ over real HTTP on an ephemeral port. Needed (not just
 * convenient) because Node's fetch() has no file:// support ("not implemented... yet..."
 * as of this Node version) — GLTFLoader's external-buffer resolution goes through fetch,
 * so a .gltf JSON's sibling .bin can only be exercised headlessly over an actual HTTP
 * transport, which also happens to be exactly what a browser uses in production.
 */
function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      const filePath = path.join(fixturesDir, requestPath);
      try {
        const data = readFileSync(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to determine fixture server address'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/` });
    });
  });
}

describe('buildSceneRegistry (synthetic two-box.gltf fixture — JSON + external .bin)', () => {
  let registry: SceneRegistry;
  let server: Server;

  beforeAll(async () => {
    const started = await startFixtureServer();
    server = started.server;

    // The fix under test: GLTFLoader.loadAsync (what Viewer.loadModel now uses for
    // string/URL sources, replacing a manual fetch+parseAsync(..., '')) resolves the
    // .gltf JSON's relative "two-box.bin" reference against this URL. A `parseAsync`
    // call with an empty path — the old code — cannot do this; see Viewer.ts's
    // loadModel and CLAUDE.md's note near invariant #4.
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(`${started.baseUrl}two-box.gltf`);
    registry = buildSceneRegistry(gltf.scene);
  });

  afterAll(() => {
    server.close();
  });

  it('loads both objects with no errors, resolving the external .bin buffer', () => {
    expect(registry.objects.size).toBe(2);
    expect(new Set(registry.objects.keys()).size).toBe(2);
    expect(registry.tree.children.map((c) => c.name).sort()).toEqual(['Box-A', 'Box-B']);
  });

  it('builds sorted, contiguous picking ranges covering both objects', () => {
    expect(registry.pickingRanges).toHaveLength(2);
    expect(registry.pickingRanges[1]!.start).toBe(registry.pickingRanges[0]!.end);
    expect(registry.pickingProxy).not.toBeNull();
  });

  it('computes a sane world-space bbox for each object (proves geometry, not just JSON, loaded)', () => {
    // Box-A: half-extents [0.5,0.5,0.5] translated to [-1,0,0] in
    // testdata/scripts/generate-two-box-gltf.mjs.
    const boxA = [...registry.objects.values()].find((o) => o.name === 'Box-A');
    expect(boxA).toBeDefined();
    expect(boxA!.bbox.min.x).toBeCloseTo(-1.5);
    expect(boxA!.bbox.max.x).toBeCloseTo(-0.5);
    expect(boxA!.centroid.x).toBeCloseTo(-1);

    // Box-B: half-extents [0.4,0.4,0.4] translated to [1,0,0].
    const boxB = [...registry.objects.values()].find((o) => o.name === 'Box-B');
    expect(boxB).toBeDefined();
    expect(boxB!.bbox.min.x).toBeCloseTo(0.6);
    expect(boxB!.bbox.max.x).toBeCloseTo(1.4);
  });
});
