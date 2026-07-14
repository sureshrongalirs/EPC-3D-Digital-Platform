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

`@plantscope/globe-view` (complete; shipped as an out-of-sequence addition, not part of the
numbered phase list below — **the authoritative Phase 5 is still "OGC 3D Tiles," not started;
do not confuse the two even though a git branch for this work was informally named
`phase-5-globe-view`**) is a **sibling rendering surface**, not a `PluginContext`-based
plugin — do not misread this as bending or breaking invariant #1.

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
  use — there is exactly one source of truth for a model's placement (the `georefs` table).
- Its only structural link to the three.js side is data, never code: it loads the same
  published GLB artifact (`ModelDto.artifactUrl`) that `Viewer.loadModel` loads, and re-derives
  a placement transform from the same `GeorefRecord` fields (`anchorLat`/`anchorLon`/`height`/
  `rotationDeg`/`anchorConvention`) that `MapGeorefPlugin`'s 2D map already visualizes — see
  `packages/globe-view/src/transform.ts` for the plant-local → ECEF math, which deliberately
  mirrors `@plantscope/shared`'s existing `localToLatLon`'s rotation convention (rotationDeg =
  degrees clockwise from north) so the two never disagree about which way "rotated" points.
- **apps/demo currently uses only the globe view.** An earlier version wired a 2D Map/Georef
  ↔ 3D Globe tab toggle (both views side by side); the three.js `Viewer`, its plugins
  (`ZonesPlugin`/`MapGeorefPlugin`/`LinkageMetadataPlugin`), and the tab-switching UI were
  later removed from `apps/demo` entirely so the globe is the app's only, primary view — see
  its own git history for that change. `@plantscope/core` and `@plantscope/plugins` are
  untouched and remain valid for any other consumer; `apps/demo` simply isn't one anymore.
  A model with no georef record is still shown (not left unplaced) at a clearly-labeled
  default location (`GlobeView.DEFAULT_FALLBACK_ANCHOR`, Hyderabad) rather than refusing to
  render it.
- Terrain/imagery defaults to Cesium Ion's hosted assets for developer convenience (that is a
  real, currently-unavoidable exception to invariant #7's "no cloud provider dependency" for
  the *default* dev experience — see `packages/globe-view`'s `GlobeProviderConfig` and its
  code comments for the token/access-requirement findings). This is never hardcoded: the
  provider config is an injectable option specifically so a self-hosted/air-gapped
  terrain+imagery source can be swapped in for a real on-premise deployment without touching
  `@plantscope/globe-view`'s own code. Google 3D Tiles (photorealistic global imagery) is
  also a supported swap this same way — set `imageryProviderUrl` to the Google Map Tiles API
  root URL with a Google Cloud API key as a query parameter, again purely a config value, no
  code change.

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
- **Phase 5 (complete):** OGC 3D Tiles path — worker tiling step (`server/worker/src/adapters/tiles/`:
  `mago-3d-tiler`, a Java 21+ CLI tool with no npm package, invoked as a child process the
  same way `assimp` already is — see `magoTiler.ts`'s doc comment for why a per-job Docker
  container invocation was ruled out, and `server/worker/Dockerfile` for how the jar + a
  portable Eclipse Temurin JRE get baked into the worker's own image at build time), 3D Tiles
  rendering in `@plantscope/core` via `3d-tiles-renderer`'s `TilesRenderer` (rendered into the
  *same* three.js scene/camera as the GLB path — see `Viewer.ts`'s `loadTilesModel()`),
  size-routed streaming for large models (`fbxAdapter.convert()` picks GLB vs. tiles by
  comparing the source file's size against `sizeThresholdMb`, both branches sharing the same
  assimp export step). `ModelDto.artifactType` (`'glb' | 'tiles' | null`) is what
  `Viewer.loadModel()` actually routes on — callers never choose or see which backend loaded.
  Tiled picking resolves through the linkage-map sidecar (`GET /api/models/{id}/linkage-map`)
  rather than the GLB path's O(log n) triangle-range resolver, since tiles have no stable
  contiguous index ranges; tiled `getObjectScreenCentroids()` reads component bboxes (`GET
  /api/components?model={id}&fields=bbox`) instead of live scene geometry, since an object's
  tile may not currently be streamed in. **Known gap, not silently glossed over:**
  `mago-3d-tiler` does not apply Draco compression natively (confirmed against its own docs)
  and per-tile Draco re-compression was left unimplemented since there was no real
  `mago-3d-tiler` output available in the environment this was built in to validate it
  against — the ≤8MB-per-tile budget is enforced for real, just via triangle-count-driven LOD
  depth rather than compression. **Corrected after real end-to-end testing** (see
  `scripts/setup-wsl-tiler.sh`, added specifically to make that testing possible in dev):
  with `-tv 1.1` (always used), `mago-3d-tiler` emits tile content as plain `.glb` files, not
  the legacy `.b3dm` container this was originally assumed to use — the size-check in
  `adapters/tiles/index.ts` originally didn't look for `.glb` at all, so it silently saw every
  tiled model as satisfying the 8MB budget regardless of real tile size. Fixed, along with
  lowering the initial max-triangles-per-tile from 30k to 5k after a real run produced a
  single 46MB tile (no subdivision at all) at the old default.
- **Phase 6 (next):** deployment hardening — full docker-compose, TLS, auth/RBAC, audit
  log, backup/restore runbook.
- **Phase 7 (not started):** E2E tests, validation harness, load testing.

**Out-of-sequence addition (complete), not part of the numbered list above:**
`@plantscope/globe-view` — a CesiumJS 3D globe view, a sibling rendering surface to
`@plantscope/core`'s three.js `Viewer` (see "Rendering surfaces" above). Built independently
of the Phase 0–7 roadmap, before Phase 5 (OGC 3D Tiles) existed; **currently disabled in
`apps/demo`** (the three.js `Viewer` is that app's active view again — see its own git
history), not deleted. It's ready to be re-enabled now that Phase 5 tiles are real: when it
is, `@plantscope/globe-view`'s model loading should prefer a model's tiles artifact over its
GLB artifact for large models (mirroring `@plantscope/core`'s own `ModelDto.artifactType`
routing) rather than always loading the GLB the way it did before Phase 5 existed — Cesium's
own tileset loading (`Cesium3DTileset`) is the natural fit there, analogous to
`3d-tiles-renderer`'s `TilesRenderer` on the three.js side, though the two renderers'
tiles-loading code remains entirely separate per this section's own "only structural link is
data, never code" rule.
