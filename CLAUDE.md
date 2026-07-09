# PlantScope

Open-source, on-premise EPC 3D digital-twin platform: a three.js viewer SDK, a Node API, a
conversion worker, and Postgres, deployed as a single docker-compose stack.

## Non-negotiable invariants

These hold across every phase. Do not propose changes that violate them without explicit
sign-off from the user — they encode hard-won constraints, not preferences.

1. **Plugins never touch three.js or the renderer.** Plugins consume only the CoreSDK facade
   and `PluginContext` exposed by `@plantscope/core`. three.js types must never appear in
   `@plantscope/core`'s public API — the facade wraps them so plugin authors never import
   `three` directly.

2. **Camera control is three.js `OrbitControls` — never hand-rolled orbit math.** A previous
   custom implementation had a documented numerical-instability bug with off-origin plant
   models (large-magnitude coordinates far from the origin lose precision under manual
   quaternion/Euler math). Always route camera orbiting through `OrbitControls`.

3. **Identity backbone: the 4-integer "Linkage" key.** It joins FBX geometry ↔ `.mdb2`
   engineering properties ↔ zones. Standard FBX loaders discard it, so we parse the raw binary
   `Properties70` node tree ourselves to recover it. Never swap in a stock FBX loader without
   preserving this parse step.

4. **Size routing at conversion time.** Source ≤ ~100 MB → single Draco-compressed GLB.
   Larger → OGC 3D Tiles streamed with `3DTilesRendererJS`, rendered into the *same* three.js
   scene graph as the GLB path (one viewer, one camera rig, two content backends). This must
   hold for real-world large files: FBX sources have been seen at 200MB+, requiring worker
   conversion parallelism to drop to 1 for large jobs (memory-bound, not CPU-bound); `.mdb2`
   sources have been seen at 800MB+, requiring streamed export and batched `COPY` inserts
   rather than buffering full tables in memory. `@plantscope/core`'s `loadModel` supports
   `.glb` and `.gltf` directly (both handled by `GLTFLoader`); `.fbx` is never parsed
   client-side — it is only ever ingested via the Phase 4 worker's server-side conversion,
   which recovers Linkage keys and produces a `.glb`/tiles artifact for the browser to load.

5. **Binaries live on the filesystem under `/data/models`.** The database stores only pointers
   and metadata — never blobs.

6. **Publish is atomic and revision-based.** A publish is a pointer flip inside a single
   transaction; there is no partial-publish state visible to readers.

7. **Deployment is one docker-compose stack, 4 services, one `/data` folder.** That folder is
   the entire backup plan. No Kubernetes, no cloud provider dependency, no message broker. The
   worker container has no outbound network access (see `deploy/docker-compose.yml`'s `backend`
   network, which is `internal: true`).

8. **Real client sample files live only in `testdata/local/` (git-ignored).** Synthetic,
   non-proprietary fixtures for CI live in `testdata/` itself. Never commit real client data.

## Georeferencing invariants

- Anchor input can arrive as an LLH file (Latitude/Longitude/Height, optionally Rotation) at
  upload time, or via the interactive Map/Georeference plugin.
- Rotation resolution precedence: (a) model-level override if set, (b) inherited from the
  model's site if the site has a saved rotation, (c) default 0° flagged for manual alignment.
  Never silently guess a rotation. This precedence is resolved by whoever WRITES a georef
  row, not by the reader, in one shared function (`resolveRotation`, now in
  `server/shared/src/lib/rotationPrecedence.ts` — extracted there in Phase 4 specifically so
  the worker could call it verbatim; see the Repo layout and Phase status sections below).
- Sites are a first-class entity: `rotation_deg`, `anchor_convention`, `height_datum` are
  site-level defaults; individual models can override without mutating the site. Propagating
  a model's rotation up to its site is an explicit user action ("save as site default"), never
  automatic.
- Georef records track both `method` (assumed/provided/provided+adjusted/surveyed/authoritative
  — trustworthiness) and `rotation_source` (model_override/site_inherited/default —
  provenance) as separate fields.
- Height datum (ellipsoidal vs. orthometric) is stored as given and never assumed; tag as
  `unknown` if unspecified.

## Rendering surfaces: the three.js Viewer and the CesiumJS globe view

`@plantscope/globe-view` (Phase 5) is a **sibling rendering surface**, not a
`PluginContext`-based plugin — do not misread this as bending or breaking invariant #1.

- It renders into its **own `<canvas>`, its own WebGL context**, driven by CesiumJS
  (`Cesium.Viewer`), entirely separate from `@plantscope/core`'s `Viewer` and its three.js
  scene graph. Nothing in `@plantscope/globe-view` touches, imports, or reaches into
  `@plantscope/core`'s internals, and nothing in `@plantscope/core` knows the globe view
  exists. Invariant #1 ("plugins never touch three.js") is about code that runs *inside*
  the `PluginContext`/`Viewer` plugin host reaching past the CoreSDK facade into three.js —
  it says nothing about, and is not violated by, an entirely independent renderer that
  happens to visualize the same underlying data elsewhere in the app.
- It depends on `@plantscope/shared` for types only (`GeorefRecord`, `ModelInfo`-shaped DTOs,
  etc.) and reads the **same catalog/georef REST API** (`GET /api/models/{id}`,
  `GET /api/models/{id}/georef`) that `MapGeorefPlugin` and the three.js `Viewer` already
  use — there is exactly one source of truth for a model's placement (the `georefs` table),
  rendered by two independent, complementary views (apps/demo wires a tab/toggle between
  them; neither replaces the other).
- Its only structural link to the three.js side is data, never code: it loads the same
  published GLB artifact (`ModelDto.artifactUrl`) that `Viewer.loadModel` loads, and re-derives
  a placement transform from the same `GeorefRecord` fields (`anchorLat`/`anchorLon`/`height`/
  `rotationDeg`/`anchorConvention`) that `MapGeorefPlugin`'s 2D map already visualizes — see
  `packages/globe-view/src/transform.ts` for the plant-local → ECEF math, which deliberately
  mirrors `@plantscope/shared`'s existing `localToLatLon`'s rotation convention (rotationDeg =
  degrees clockwise from north) so the two views never disagree about which way "rotated" points.
- Terrain/imagery defaults to Cesium Ion's hosted assets for developer convenience (that is a
  real, currently-unavoidable exception to invariant #7's "no cloud provider dependency" for
  the *default* dev experience — see `packages/globe-view`'s `GlobeProviderConfig` and its
  code comments for the token/access-requirement findings). This is never hardcoded: the
  provider config is an injectable option specifically so a self-hosted/air-gapped
  terrain+imagery source can be swapped in for a real on-premise deployment without touching
  `@plantscope/globe-view`'s own code.

## Repo layout

```
.
├── packages/
│   ├── core/          @plantscope/core     — viewer SDK, CoreSDK facade, PluginContext
│   ├── plugins/       @plantscope/plugins  — first-party plugins (core-facade consumers only)
│   ├── shared/        @plantscope/shared   — types/utilities shared across packages
│   └── globe-view/    @plantscope/globe-view — CesiumJS 3D globe view; a sibling rendering
│                      surface to @plantscope/core, not a plugin — see "Rendering surfaces" above
├── server/
│   ├── shared/        @plantscope/server-shared — DB layer (Database, migrations, repo/*,
│   │                  publishRevision, resolveRotation) shared by api and worker; Node-only,
│   │                  so it lives under server/, not packages/ (see Phase 4 note below)
│   ├── api/           @plantscope/api      — Node API (pointers/metadata, publish transactions)
│   └── worker/        @plantscope/worker   — conversion worker (FBX/.mdb2 → GLB or 3D Tiles)
├── apps/
│   └── demo/          @plantscope/demo     — minimal Vite app proving workspace linking
├── deploy/
│   ├── docker-compose.yml   — nginx, api, worker, postgres:16; single ./data bind mount
│   └── nginx/               — reverse-proxy config
├── testdata/          synthetic CI fixtures (testdata/local/ = git-ignored real samples)
└── .github/workflows/ci.yml — install, lint, typecheck, build, test
```

## Phase status

This is the authoritative phase sequence — do not renumber or reinterpret it in future
sessions.

- **Phase 0 (complete):** repo scaffold — pnpm workspaces, TypeScript strict/ESM, ESLint +
  Prettier, Vitest, CI, docker-compose skeleton.
- **Phase 1 (complete):** `@plantscope/core` — CoreSDK facade, PluginContext, three.js
  viewer internals, OrbitControls, GLB loading, O(log n) picking, model tree, plugin host.
- **Phase 2 (complete):** first-party plugins (zones, map/georeference, linkage-metadata)
  against the Phase 1 facade only.
- **Phase 3 (complete):** API server + Postgres — catalog, upload, zones/georef/components
  endpoints, Range-enabled static serving, atomic publish transaction.
- **Phase 4 (complete):** conversion worker — queue (`SELECT ... FOR UPDATE SKIP LOCKED`,
  stall recovery, probe-based adaptive parallelism), FBX/GLB/mdb2/LLH format adapters (IFC/RVM
  registered as explicit "not yet implemented" stubs), the raw-binary FBX Properties70/Linkage
  parser (cross-verified against an independent Python ground-truth parser,
  `scripts/fbx_linkage_check.py`), streamed mdb2 join + batched inserts, and atomic publish
  integration. **Architectural note:** `publishRevision`/`resolveRotation`/the DB layer were
  extracted out of `server/api` into a new `server/shared` package (`@plantscope/server-shared`)
  so the worker could call them verbatim rather than duplicating the logic — see the Repo
  layout section above. `packages/*` stays browser-safe (bundled into `apps/demo`); this new
  code is Node-only and consumed only by `server/api` and `server/worker`, hence `server/shared`
  rather than `packages/shared`.
- **Phase 5 (next):** OGC 3D Tiles path — worker tiling step, 3DTilesRendererJS in the
  SDK, size-routed streaming for large models.
- **Phase 6 (not started):** deployment hardening — full docker-compose, TLS, auth/RBAC, audit
  log, backup/restore runbook.
- **Phase 7 (not started):** E2E tests, validation harness, load testing.
