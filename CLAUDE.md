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
   rather than buffering full tables in memory.

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
  Never silently guess a rotation.
- Sites are a first-class entity: `rotation_deg`, `anchor_convention`, `height_datum` are
  site-level defaults; individual models can override without mutating the site. Propagating
  a model's rotation up to its site is an explicit user action ("save as site default"), never
  automatic.
- Georef records track both `method` (assumed/provided/provided+adjusted/surveyed/authoritative
  — trustworthiness) and `rotation_source` (model_override/site_inherited/default —
  provenance) as separate fields.
- Height datum (ellipsoidal vs. orthometric) is stored as given and never assumed; tag as
  `unknown` if unspecified.

## Repo layout

```
.
├── packages/
│   ├── core/          @plantscope/core     — viewer SDK, CoreSDK facade, PluginContext
│   ├── plugins/       @plantscope/plugins  — first-party plugins (core-facade consumers only)
│   └── shared/        @plantscope/shared   — types/utilities shared across packages
├── server/
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
- **Phase 1 (not started):** `@plantscope/core` — CoreSDK facade, PluginContext, three.js
  viewer internals, OrbitControls, GLB loading, O(log n) picking, model tree, plugin host.
- **Phase 2 (not started):** first-party plugins (zones, map/georeference, linkage-metadata)
  against the Phase 1 facade only.
- **Phase 3 (not started):** API server + Postgres — catalog, upload, zones/georef/components
  endpoints, Range-enabled static serving, atomic publish transaction.
- **Phase 4 (not started):** conversion worker — queue, assimp FBX→GLB, raw-binary FBX
  Properties70/Linkage parser, `.mdb2` join, atomic publish integration.
- **Phase 5 (not started):** OGC 3D Tiles path — worker tiling step, 3DTilesRendererJS in the
  SDK, size-routed streaming for large models.
- **Phase 6 (not started):** deployment hardening — full docker-compose, TLS, auth/RBAC, audit
  log, backup/restore runbook.
- **Phase 7 (not started):** E2E tests, validation harness, load testing.
