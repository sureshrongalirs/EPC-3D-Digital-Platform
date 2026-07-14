# Phase 5R Task 0 — mago-3d-tiler upstream re-validation spike

**Date:** 2026-07-14
**JAR under test:** `mago-3d-tiler` **v1.15.4**, resolved via `scripts/setup-wsl-tiler.sh`.
Cross-checked against GitHub's `releases/latest` API (`tag_name: v1.15.4`) at the time of this
spike — **we are already on the current latest release**; there is no newer JAR to pull.

## Fixture generator

`testdata/scripts/generate-plant-grid-fixture.mjs` (committed; output never committed, per
CLAUDE.md invariant #8's spirit). Exports `generatePlantGridFixture(outDir, mode, objectCount,
segments)`:

- `mode: 'merged'` — one `model.glb` containing `objectCount` named nodes/meshes in a grid
  layout.
- `mode: 'split'` — a directory of `objectCount` separate `Object_NNNNN.glb` files, one node/
  mesh each.
- Each object is a subdivided box (`segments` quads/edge/face) so per-object triangle density —
  and therefore total file size — is tunable independently of object count.
- Unit-tested at small scale (25 objects) in `server/worker/src/adapters/tiles/
  fixtureGenerator.test.ts`, following the existing dynamic-import-from-testdata/scripts pattern
  established by `server/worker/src/adapters/mdb2/ingest.test.ts`.

**Methodology correction made during this spike:** the generator's first draft omitted (a) an
explicit default scene and (b) a material on each primitive. (a) alone reproduced `Total Node
Count 0`; fixing it wasn't sufficient. (b) turned out to be necessary too — a minimal
single-quad repro confirmed mago-3d-tiler's loader silently treats unmaterialed primitives as
contributing zero nodes. **Real assimp-exported GLBs always carry a material per primitive**,
which is why the FBX worker path never hit this — but it meant the first-draft fixture wasn't
representative of real input, so its early "merged mode crashes immediately" result was a
fixture bug, not a mago finding. Both issues are now fixed in the committed generator (default
scene + material set unconditionally in both modes).

## Commands run

All runs: `java -jar /opt/mago-3d-tiler.jar -input <dir> -output <dir> -inputType glb
-outputType b3dm -tv 1.1 -mx 5000` (the flags this repo's `magoTiler.ts` currently passes,
minus the confirmed-broken `-sbn` and the confirmed-no-op `-nl`/`-xl`/`-mg`, per existing
ground truth — this spike did not re-test those, only the merged-vs-split input shape).

## Mode (a): single merged GLB — results at multiple scales

| Objects | Segments | Total size | `[Pre] Total Node Count` | Result |
|---|---|---|---|---|
| 10 | 7 | 0.1MB | 1 | Succeeds — **4 tile contents** (fixed LOD chain, not real subdivision) |
| 500 | 7 | 5.8MB | 1 | Succeeds — **4 tile contents** |
| 1,000 | 7 | 11.6MB | 1 | Succeeds — **4 tile contents** |
| 2,000 | 7 | 23.2MB | 1 | Succeeds — **4 tile contents** |
| 3,000 | 7 | 34.9MB | 1 | Succeeds — **4 tile contents** |
| 4,500 | 7 | 52.3MB | 1 | Succeeds — **4 tile contents** |
| 4,750 | 7 | 55.2MB | 1 | **Crashes**: `TileProcessingException: Tileset root node children is null or empty` |
| 5,000 | 7 | 58.1MB | 1 | **Crashes**, same exception |
| 6,000 | 7 | 69.7MB | 0 at this size; **1** at ≤5,000 | **Crashes** (at 6,000, `Total Node Count` itself drops to 0 — a second, more severe failure mode) |

Two distinct, confirmed failure modes for single-merged-file input, not one:

1. **Below ~4,500 objects (~52MB / ~2.6M triangles at this fixture's density):** mago
   "succeeds" but produces the same fixed **4** tile content nodes regardless of real object
   count or size — this is the previously-documented fake/templated LOD-chain behavior
   (issue #37: "we do not currently do triangle reduction when generating generic b3dm...
   tiling a single file appears to be a copy of the same file"), now reconfirmed directly
   against v1.15.4 across a 600x size range (10 → 4,500 objects) with a properly-materialed
   fixture.
2. **Above that threshold, mago crashes outright** (`Tileset root node children is null or
   empty`, exit via uncaught exception) rather than degrading — a new finding this spike
   surfaced, not previously documented. This is **worse** than the known degenerate case: it's
   a hard job failure with zero usable output, not just an oversized/wrong tile.

**Important caveat, stated plainly rather than silently reconciled:** the real `PDA-PO.fbx`
(90MB source → ~70MB assimp-exported GLB, 8,511 nodes, 1,390,693 real triangles) tested earlier
this session did **not** crash — it hit failure mode 1 (single ~46MB tile), not mode 2, despite
having far more *objects* (8,511) than this spike's ~4,750-object crash threshold. The
likely reconciliation: this synthetic fixture's objects are far denser than PDA-PO's real
geometry averages out to (588 triangles/object at `segments=7` → ~2.6-2.8M total triangles at
the 4,500-4,750 crossover, vs. PDA-PO's 1.39M total triangles across 8,511 objects, ~163
triangles/object average). This suggests the crash threshold tracks **total triangle/vertex
count**, not object count — but that's an inference from this spike's data, not something
verified against mago's source. Practical implication either way: **a single merged GLB from a
large real client file can, depending on its exact triangle density, either silently produce
wrong output (documented) or crash the job entirely with zero output (newly confirmed possible)
— both are unacceptable, and Task 1's validation/repair gate needs to treat "mago produced no
tileset.json at all" as a first-class failure case, not just "tileset.json references missing
files."**

## Mode (b): directory of separate per-object GLBs — result

6,000 objects, `segments=7`, 71.0MB total across 6,000 files:

```
[Pre] Total Node Count ... (per-file loading, 6,000 files)
...
[Process Summary]
Total tile contents count : 142
Total tileset.json File Size : 32KB
Total process time : 16s 873ms
```

- **142 real, spatially-subdivided tile files**, named by real quadtree/octree region codes
  (`R0C0000.glb`, `R110C1110.glb`, etc.) — not a flat/fake LOD-copy chain.
- Largest tile: **4.1MB** — comfortably under the 8MB budget, no repair or backoff needed.
- Verified independently (not just from mago's own log): parsed the real output
  `tileset.json`, walked every `content.uri` in the tree, confirmed **all 142 referenced files
  exist on disk** — zero missing, zero orphans.
- Total process time: ~17s for 71MB / 6,000 objects.

This directly confirms `znkim`'s maintainer comment on issue #37 ("there will be differences
when tiling multiple files") against the actual current release, with real, verifiable output.

## GO/NO-GO conclusion

**GO — proceed with Task 1 and Task 2 as specced. No premise from prior sessions is
contradicted; one is *strengthened* (the newly-found crash-at-scale failure mode) and one
fixture-methodology bug (missing material) is corrected along the way.**

- Task 2's splitter (directory-of-per-object-GLBs) is **not** unnecessary — it is the only
  tested approach that produces real, budget-compliant, validator-passable spatial subdivision
  on the current latest mago-3d-tiler release.
- Task 1's integrity gate is **more clearly justified** than originally scoped: single-merged-
  file input isn't just capable of the known "tileset references missing files" failure — it
  can also crash with **zero** tileset.json output whatsoever above some density threshold. The
  gate (and the worker's job-failure handling generally) must treat "no tileset.json produced"
  as an explicit, structured failure, not only "tileset.json is present but invalid."

## Scope check

Zero changes to `server/` or `packages/` production code in this task. Changed/added:
- `testdata/scripts/generate-plant-grid-fixture.mjs` (new)
- `server/worker/src/adapters/tiles/fixtureGenerator.test.ts` (new)
- `docs/phase5r/task0-findings.md` (this file)
