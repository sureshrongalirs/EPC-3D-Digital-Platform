# Phase 5R Task 3 findings — tiles serving + client consumption

**Date:** 2026-07-16

## 1. mago-3d-tiler already embeds real per-object identity via `EXT_mesh_features`/`EXT_structural_metadata`

The design checkpoint's initial investigation (using `@gltf-transform/core`'s `NodeIO` to
inspect a real published tile, model `fefe1c90-7f9f-41f3-84b2-58f8e8f20d28`) concluded mago's
tile content carried **no** usable per-object identity: every mesh node was named generically
(`RootNode` → `BatchedRootNode` → repeated `node`), with no extras, and `listExtensionsUsed()`
returned `[]` — despite `NodeIO` printing "Missing optional extension, EXT_mesh_features" /
"Missing optional extension, EXT_structural_metadata" warnings on every read. That inconsistency
was the tell: `NodeIO` doesn't have those extensions registered, so it silently drops them on
read while still warning about them.

Manually parsing the raw GLB binary container (12-byte header + chunk0 JSON, bypassing
gltf-transform entirely) on the same tile (`tiles/data/R0C0000.glb`) shows the opposite:

- `extensionsUsed: ["EXT_mesh_features", "EXT_structural_metadata"]`.
- A top-level `extensions.EXT_structural_metadata.schema` defining class `mago_metadata_schema`
  with four STRING properties: `NodeName`, `BatchId`, `FileName`, `id`.
- One `propertyTables` entry (23 rows for this tile) holding those four columns.
- Every mesh primitive's `extensions.EXT_mesh_features.featureIds` points a `_FEATURE_ID_0`
  vertex attribute at that property table.

Decoding the property table's actual string values (parsing `bufferViews`/`accessors`
directly) confirms `FileName`/`NodeName` match `metadata.json`'s own `file`/`name` fields
**byte-for-byte** (`Object_1880.glb` / `Object_1880`) for all 23 sampled rows. `id` is a
mago-generated UUID, unrelated to this platform's schema — not used.

**Upgrades a previously-listed follow-up item**: "embed per-object identity via
`EXT_mesh_features`/`EXT_structural_metadata`" was carried as future work after Task 2/5. It's
moot — mago already does this, upstream, for free. The only genuinely open follow-up in this
space is the *reverse* direction: embedding **this platform's own** properties (e.g. full
engineering-component data, not just `NodeName`/`FileName`/`id`) into that same extension
mechanism, if a future need for offline/no-round-trip metadata access ever arises. Not attempted
this task (out of scope per the binding constraints — no `EXT_mesh_features` embedding as a
Task 3 deliverable).

**3d-tiles-renderer@0.4.28 ships loader plugins for both extensions**
(`GLTFMeshFeaturesExtension`, `GLTFStructuralMetadataExtension`, importable from
`3d-tiles-renderer/plugins`), which attach `MeshFeatures`/`StructuralMetadata` instances to
`mesh.userData` on load — real, standards-based accessors (`getFeatures(triangle, barycoord)`,
`getPropertyTableData(tableIndex, id)`), not a hand-rolled parser. `Viewer.ts`'s
`performTiledPick()` now uses these directly (see `internal/tiles.ts`'s
`resolveTiledPickMetadata()`).

## 2. `resolveTiledObjectId` was dead code (same lesson as historic bug #4)

CLAUDE.md's own Phase 5 completion notes, and the pre-Task-3 `performTiledPick()`, resolved a
tiled pick by walking up from the hit object to the nearest ancestor with a non-empty `.name`,
matched against the linkage-map sidecar. Real mago-3d-tiler output (finding #1's own tile
inspection) never sets a distinguishing `.name` on any tile mesh node — every one is
`"RootNode"` → `"BatchedRootNode"` → repeated `"node"`. This mechanism could not have ever
resolved a real pick; it was dead code from the moment `loadTilesModel()` first loaded a real
tile. Deleted (`resolveTiledObjectId` and its test) per design-checkpoint sign-off item 3,
rather than kept as an inert fallback — same category of gap as historic bug #4 (a mechanism
that looked complete and tested but never engaged real data).

## 3. CI has not actually typechecked `dev` since before Phase 5R started

`.github/workflows/ci.yml` triggers on `push: [main]` and `pull_request` (any branch) — **not**
on a push to `dev`. Phase 5R's work (Tasks 0-2, PR #13 included) landed on `dev` via direct
`git merge --ff-only` / `git push origin dev` (per this session's own established protocol),
never through a GitHub PR merge. Consequently `pnpm -r typecheck` has not actually run against
any of this work until this task ran it locally.

This surfaced a real, pre-existing typecheck failure (confirmed via `git stash` against this
branch's own pre-Task-3 `dev` code, not introduced by Task 3): every call site touching
`tilesRenderer.group` (`scene.add`, `scene.remove`, `raycaster.intersectObject`) fails
type-checking, because 3d-tiles-renderer's own shipped `.d.ts` files resolve the bare `'three'`
specifier to three.js's untyped `.js` entry point (three.js ships no bundled `.d.ts`; `@types/
three` supplies it, but only resolves correctly for this repo's own source files, not from
inside a dependency's own `node_modules` location — traced with `tsc --traceResolution`).
Runtime behavior is entirely unaffected (`tilesRenderer.group` is a real `THREE.Group` at
runtime); this is a type-only gap. Fixed narrowly in `Viewer.ts` via a single documented
`asObject3D()` cast (not a workspace-wide dependency-resolution fix, which would be
disproportionate scope for this task) — see its own doc comment. A second, related gap in the
same family: `GLTFMeshFeaturesExtension`/`GLTFStructuralMetadataExtension`'s shipped `.d.ts`
declares no explicit constructor (TypeScript infers a 0-arg default) despite taking a
`GLTFParser` argument at runtime — same fix pattern, cast once at the two construction sites.

**This is a real gap in the repo's CI setup**, unrelated to Task 3's own scope, worth a
follow-up: either trigger CI on `push` to `dev` too, or require PRs (not direct pushes) for
merges to `dev`, so typecheck actually runs before code lands there.

## 4. `linkage-map.json`'s keys already match mago's `NodeName` — no new join table needed

`linkage-map.json` (written by the Phase 4 FBX adapter, keyed by FBX node name) turned out to
be keyed by exactly the same strings as `metadata.json`'s own `file`/`name` fields
(`Object_6`, `Object_8`, ...) — both ultimately derive from `splitter.ts`'s per-object naming
convention. Task 3's pick-resolution mechanism (finding #1) resolves straight to a
`metadata.json` record, which already carries its own `linkageKey` field, making a second
lookup through `linkage-map.json` redundant for this purpose. `linkage-map.json` and its
serving route are unchanged and left in place (still used for join-coverage computation in
`pipeline.ts`, and potentially other consumers) — only `Viewer.ts`'s own tiled-pick code
stopped calling it.
