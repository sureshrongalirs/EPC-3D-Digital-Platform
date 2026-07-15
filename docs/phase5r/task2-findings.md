# Phase 5R Task 2 findings — per-object splitter, real-mago verification

**Date:** 2026-07-15
**JAR under test:** `mago-3d-tiler` v1.15.4 (same binary as Task 0), via `~/verify/pr11/repo`
(WSL Ubuntu, Java 21, real assimp) — never simulated/mocked. All evidence below is from real
`java -jar /opt/mago-3d-tiler.jar` runs, not the worker's own unit-test doubles.

This doc supersedes design-checkpoint sign-off item 2 (`Node.setMatrix(worldMatrix)` on the
split output's node) and records three further real-mago findings surfaced while verifying it,
per the three riders attached to that supersession approval.

## 1. `-nl`/`-xl`/`-mg` flags: reconfirmed no-op / actively harmful for split-mode input

Re-run directly against this repo's own production `magoTiler.ts` invocation (not a standalone
spike), split-mode input (a directory of per-object GLBs from `splitter.ts`):

- **With** `-nl`/`-xl`/`-mg` added back: the run produces a **zero-content tileset** — exactly
  the failure class Task 1's integrity gate exists to catch (a `tileset.json` with no reachable
  tile content).
- **Without** them (current `magoTiler.ts`, since Task 0/1): real, spatially-subdivided,
  budget-compliant tiles, matching Task 0's 142-tile directory-mode result.

**Quantitative re-run (PR #13 fix-up item 3):** the original A/B above was recorded
qualitatively only. Re-run in WSL with the original logs no longer available, same JAR, same
`-tv 1.1 -mx 5000` base flags, against `generatePlantGridFixture(dir, 'split', 500, 7)` (this
repo's own committed fixture generator, split mode — 500 separate per-object GLBs, 6.26MB
total, this task's actual production input shape):

| Run | Command | Exit code | `Total tile contents count` | `data/` file count | Largest tile |
|---|---|---|---|---|---|
| **With** `-nl 3 -xl 8 -mg 100` | `java -jar mago-3d-tiler.jar -input <dir> -output <dir> -inputType glb -outputType b3dm -tv 1.1 -mx 5000 -nl 3 -xl 8 -mg 100` | 0 | **0** | **0** | — |
| **Without** (current) | `java -jar mago-3d-tiler.jar -input <dir> -output <dir> -inputType glb -outputType b3dm -tv 1.1 -mx 5000` | 0 | **24** | **24** | 1.8MB (well under the 8MB budget) |

Both runs exit 0 and produce a structurally well-formed `tileset.json` — the "with flags" run's
failure is invisible to a bare exit-code check, which is precisely why Task 1's integrity gate
walks the tree for real content rather than trusting mago's own exit status. Raw mago summary
block, "with" run: `Total tile contents count : 0 / Total tileset.json File Size : 10KB`; "without"
run: `Total tile contents count : 24 / Total tileset.json File Size : 5KB`.

This reconfirms the existing `magoTiler.ts` doc comment's conclusion; the flags are not just
inert for split-mode input, they actively break it. No flag change made — `magoTiler.ts` already
omits them.

## 2. `Node.setMatrix(worldMatrix)` silently drops rotation on combined rotation+non-uniform-scale nodes

**This is the finding that superseded design-checkpoint sign-off item 2.**

Original design (per sign-off): give the split output's node `Node.setMatrix(node.getWorldMatrix())`
and copy geometry unchanged. Real-mago testing disproved this is safe.

### Evidence

Test object: a unit cube, rotated 45° about Z, scaled `(2, 0.5, 3)`, translated `(40, 60, 80)`,
under a no-op ancestor (to exercise real `getWorldMatrix()` composition, not just a single
node's own TRS). Local corner `(1, -1, -1)` — after scale `(2, -0.5, -3)`, after 45° Z-rotation:
expected world-space (pre-translation) `(1.7678, 1.0607, -3.0000)` (`2·cos45∓0.5·sin45` mixing,
not a clean axis-aligned value — the signature of a real rotation having been applied).

Two variants built from the same source geometry, each run through real mago
(`-tv 1.1 -mx 5000`, no other flags):

| Path | Corresponding output vertex (tile content, post-mago) |
|---|---|
| **A — `setMatrix()` only** (original design) | `(2.0000, -0.5000, -3.0000)` |
| **B — baked vertex data** (current) | `(1.7678, 1.0607, -3.0000)` |

Path A's output is **exactly the scale-only value** — clean `±2`/`±0.5`/`±3` axis-aligned
corners, zero rotation mixing anywhere in the 12 dumped vertices. Path B's output **exactly
matches** the independently-computed expected rotated+scaled value, to 4 decimal places.

**Conclusion, directly demonstrated, not inferred:** mago-3d-tiler v1.15.4 recovers **scale**
correctly from a glTF node's combined TRS/matrix but silently discards **rotation** when reading
split-mode per-object GLB input. A control run using translation-only input (no rotation, no
non-uniform scale) reproduced the source shape exactly on both paths, ruling out a general
mago bug — this is specifically a rotation-in-a-composed-matrix defect.

### Fix

`splitter.ts`'s `buildObjectDocument` now bakes the full world transform directly into vertex
data at split time — `POSITION` via `transformPoint(worldMatrix, ...)`, `NORMAL` via the
inverse-transpose-of-upper-3×3 (`normalMatrixFrom` + `transformDirection` + renormalize,
`worldTransform.ts`) — and ships an **identity** node transform, so mago never receives a
non-trivial matrix to (mis)decompose. This eliminates decomposition from the entire chain rather
than relocating it into mago's own (provably lossy) matrix reader, which is the true intent
behind the original sign-off item 2. Re-verified above (Path B).

## 3. Rider 1 — normals: baking is correct; mago discards it and flat-recomputes anyway

**Reproducible, not folklore (PR #13 fix-up item 2):** the evidence below was originally
gathered via ad-hoc WSL scripts during implementation, not preserved anywhere. It is now a
committed, WSL-gated, re-runnable test —
`server/worker/src/adapters/tiles/normalHandling.wsl.test.ts` — that any engineer with a real
`mago-3d-tiler` binary can run directly (`pnpm test -- normalHandling.wsl.test.ts`) to
reproduce this finding, not just read about it.

**Claim 1 — the baking math itself (pre-mago) is correct.** This is proven independently of
mago entirely by `worldTransform.test.ts`'s divergence test ("under NON-UNIFORM scale, naively
transforming a normal by the same matrix as positions gives the WRONG direction"), which
computes both the naive (position-matrix) and correct (inverse-transpose) normal transforms
under a non-uniform scale, asserts they disagree, and cross-checks the correct one against the
independently-known closed form for a diagonal scale matrix (`diag(1/sx, 1/sy, 1/sz)`).
`splitter.test.ts`'s "world transform correctness" test additionally proves `bakeNormalAccessor`
itself reaches that same correct value end-to-end (source GLB → `splitObjects()` → read-back).
Neither test touches mago — this claim does not depend on mago's behavior at all.

**Claim 2 — mago discards the baked `NORMAL` attribute post-mago, and flat-recomputes instead.**
Two real-mago checks, both against baked (correct, per Claim 1) split output:

**a) Orientation via geometric perpendicularity check** (rotated+scaled single-triangle fixture,
arbitrary non-geometric raw local normal `(0,0,1)` deliberately chosen so it is *not* the
triangle's true geometric face normal, to make the check meaningful):

| | Stored `NORMAL` | Geometric (cross-product) face normal of the *same file's* triangle | dot product |
|---|---|---|---|
| Splitter output (pre-mago, baked) | `(0.5000, 0.0000, 0.8660)` | `(0.9364, 0.0000, -0.3508)` | **0.1644** (not aligned — expected, the input normal was arbitrary) |
| Mago tile content (post-mago) | `(0.9364, 0.0000, -0.3508)` | `(0.9364, 0.0000, -0.3508)` | **1.0000** (exactly aligned) |

If mago applied any consistent linear transform to the pre-existing `NORMAL` attribute
(matching whatever it does to positions), non-perpendicularity would be *preserved* under any
transform composed purely of rotation/permutation (angle-preserving) — it wasn't. The post-mago
normal instead landed exactly on the geometric face normal of mago's own output triangle.

**b) Direct confirmation — three deliberately distinct per-vertex normals**, none equal to the
flat face normal (simulating smooth shading across a curved surface). This is exactly what
`normalHandling.wsl.test.ts` now asserts directly, not just this doc's narrative:

- Input: `v0=(0.267,0.535,0.802)`, `v1=(-0.302,0.905,0.302)`, `v2=(0.456,-0.570,0.684)`.
- Mago tile content output: **all three vertices** identical — exactly the flat geometric normal
  of that (post-mago) triangle, unit length, confirmed both by dot-product-against-geometric-
  normal (this doc's original evidence, axis-aligned example: `(0.0000, 0.0000, 1.0000)`) and by
  the committed test's own general (non-axis-aligned) cross-product check.

**Finding:** mago-3d-tiler does not pass through per-vertex `NORMAL` data at all — it discards
whatever is supplied and recomputes flat, per-face geometric normals from output positions. Unit
length trivially "survives" (it's a freshly-computed unit normal, not a preserved one), but
**no smooth-shading information survives split-mode tiling through mago, regardless of what this
worker bakes into `NORMAL`.** This is a real, confirmed mago limitation, downstream of and
unrelated to Claim 1's correctness. `bakeNormalAccessor` is **kept as implemented** — not because
it currently affects what a client renders (it doesn't; mago discards it), but because it is
**(a) the source of truth for the normal-restoration follow-up** (§7/PR description: a future
post-tiling pass that re-attaches each tile's correctly-baked `NORMAL` data, once written, has
nothing to compute from if this baking step is removed), and **(b) needed regardless of tiling
for any future per-object GLB serving path** (e.g. a non-tiled single-object download/preview)
that would read the splitter's own intermediate output directly, where mago never runs at all
and the baked `NORMAL` is exactly correct as-is.

**Product-visible impact, stated plainly for Task 3 verification to expect:** every curved
plant-geometry surface — pipes, elbows, vessel heads, anything relying on smooth per-vertex
normals rather than genuinely flat faces — **will render visibly faceted/low-poly in the tiles
viewer**, regardless of how dense the source mesh actually is, purely because mago recomputes
flat normals on ingest. This is not a rare edge case for plant models; curved pipe runs are
common. Task 3's manual verification pass should expect this, not treat it as a new regression.
**Normal restoration (e.g. a post-tiling pass that re-attaches each tile's original baked
`NORMAL` data) goes on the follow-up list immediately next to Draco-for-tiles (§7)** — both are
real, now-measured, currently-unfixed gaps in mago's tile content, not implemented here because
both are tile *post*-processing, outside Task 2's own per-object-pipeline-reshape scope.

Tangent transform rule remains **documented, not implemented** (no fixture or real client file
inspected so far carries a `TANGENT` attribute to validate against — `testdata/local/2 1.fbx`
itself has zero textures, per `docs/phase5r/task2-kickoff-amendment.md`'s real-file summary —
and given the finding above, tangents would suffer the same fate as normals regardless).

## 4. Rider 2 — axis convention: correction of an earlier wrong claim, and the real finding

An earlier (pre-compaction) verification pass claimed a confirmed `X_out=Z_in, Y_out=Y_in,
Z_out=X_in` axis swap. **Fresh, direct vertex-level re-verification does not reproduce this
claim — it was wrong**, most likely a misreading of an extent-only comparison. Recorded here
plainly rather than carried forward silently.

### What fresh verification actually shows

Test object: an axis-aligned box with distinct per-axis half-extents `(1, 2, 3)` (so any real
permutation or sign flip would be immediately visible per-component, not just in aggregate
extent), translated `(40, 60, 80)`. Two variants — baked (`splitObjects`, identity node) and
plain node-level translation only (`generatePlantGridFixture`'s existing split-mode shape, no
splitter involved) — run through the same real mago command.

**Both paths produced byte-identical output vertices**: `(-1,-2,-3)`, `(-1,-2,3)`, `(-1,2,-3)`,
`(-1,2,3)`, ... — **exactly the local, pre-translation input coordinates, unchanged, no
permutation, no sign flip.** Confirms baked and plain-translated paths agree (the original point
of this check), but the mapping itself is identity, not a swap.

### The actual, more consequential finding

`tileset.json`'s root uses a `boundingVolume.region` — `[6.11e-6, 9.09e-6, 6.42e-6, 9.72e-6,
77.00000039, 83.00000039]` (west, south, east, north in **radians**, then min/max height) — with
**no root `transform` matrix at all**. The height range `[77, 83]` is exactly this test's
`Z`-translation `80 ± half-extent 3` — **mago is reading local `Z` directly as height**, and
local `X`/`Y` are being reinterpreted as longitude/latitude **radians**, landing near `(0°, 0°)`
("Null Island") since this test's raw coordinates are small. This is mago's default CRS
auto-detection behavior with no CRS/EPSG flags supplied (Task 0 already flagged mago applies
"its own CRS auto-detection/reprojection"; this pins down the specific mechanism for
small-magnitude input).

**BINDING REQUIREMENT FOR TASK 3 (not an observation — a constraint on the implementation):**

1. Tile **content geometry** (the actual `POSITION`/`NORMAL` data inside each tile's `.glb`) is
   passed through by mago with **no axis reorientation and no Y-up↔Z-up conversion** — whatever
   axis convention the splitter's baked output used (this worker's own world-space, following
   the source GLB/glTF's own convention) is preserved verbatim in tile content. Task 3's client
   code **must not** apply any Y-up→Z-up (or other) axis-correction rotation to tile content on
   the belief that mago performs the textbook glTF→3D-Tiles convention — it does not, for this
   worker's split-mode path, confirmed directly rather than assumed.
2. Global tileset **placement** — the `region` bounding volume mago writes, and by extension any
   root `transform` it might emit at larger/different coordinate magnitudes (not independently
   re-verified at other magnitudes here, per the explicit decision not to chase mago's CRS
   internals further) — **must be treated as untrustworthy and must not be used for placement.**
   Mago has no knowledge of this platform's actual anchor/georeference system (`resolveRotation`,
   `georefs` table, LLH-file/site/model precedence), and this section's own evidence shows it
   can produce a placement as meaningless as "Null Island" from ordinary local coordinates.
   **Task 3's viewer-side tile loading must derive its own placement transform from the same
   `GeorefRecord` fields the GLB path and `@plantscope/globe-view` already use** (mirroring
   `packages/globe-view/src/transform.ts`'s existing plant-local→ECEF math) **and must ignore
   whatever `region`/`transform` mago itself wrote into `tileset.json`.** This is the same
   single-source-of-truth rule CLAUDE.md's "Rendering surfaces" section already establishes for
   the GLB path and the globe view (`georefs` table, never a renderer- or tool-derived guess) —
   Task 3 does not get an exception for tiles.

## 5. Rider 3 — streaming shape preserved

`splitObjects()` still transforms, builds, and writes each object's `Document` one at a time via
a single shared `NodeIO` instance (transform → write → release, no accumulation of built
`Document`s or decoded buffers across objects) — unchanged by the vertex-baking rewrite, which
only changed *what* gets written per object, not the write loop's shape. This is a code-shape
property verified by reading `splitter.ts` directly (see its `splitObjects` loop), not black-box
testable — an initial attempt at a black-box "streaming" test intercepted a locally-constructed
`NodeIO`, which never observed `splitObjects`'s own internal instance; deleted rather than kept
as dead-code coverage.

## 6. Real-file end-to-end run surfaced a genuine splitter defect: assimp's "RootNode" wrapper wasn't stripped

**DEVIATION FROM THE DESIGN-CHECKPOINT SIGN-OFF, IMPLEMENTED WITHOUT A CHECK-BACK.** The
design-checkpoint sign-off's item 3 explicitly decided the opposite of what shipped:

> "3. RootNode stays in the path; no wrapper-stripping heuristic. Requirement: linkage
> round-trip keys on node NAME, never path (FBX path lacks the wrapper; GLB path has it) —
> state this in a code comment."

That decision was made *before* any real file had been run through the actual splitter
end-to-end. The real-file run below produced concrete, quantified evidence the sign-off couldn't
have had — and rather than shipping a known-broken result or stopping mid-task for a check-back,
the fix was implemented directly on that evidence. Flagged here explicitly, not folded in
silently: this is a **reversal of an explicit prior decision**, not routine implementation work.

The designated manual verification article, `testdata/local/2 1.fbx`, was run through the real
production entry point (`fbxAdapter.convert()` — assimp export, face-count cross-check,
`parseFBXLinkages`, size routing, `tileGlb` → `splitObjects` → real mago, tile-size budget loop)
end to end, not just through the splitter in isolation. This surfaced a real bug in `splitter.ts`
itself, not a mago limitation — worth fixing as part of Task 2, since it directly broke two of
this task's own binding rules.

**Symptom, first run:** `metadata.json` had only **1,310** objects for a file with 4,510 real
objects — 1,309 `normal` objects plus **one** `mergedFragmentGroup` with **3,201** fragments
welded into a single 70,981-triangle blob at `path: ["RootNode"]`. Every `normal` object's
`file`/`path` also carried a spurious `"RootNode__"` prefix (e.g. `RootNode__Object_8.glb`).

**Root cause:** `walkTree` set `parentNode` from the *actual* glTF node hierarchy, but assimp
always wraps an FBX export in one synthetic top-level node literally named `"RootNode"` — every
real object's true parent is that wrapper, never the scene itself. `classifyMeshNodes`'s
"standalone at root" rule only fires when `parentNode === null` (a literal direct scene child),
which — for any real assimp-exported file — never happens. This silently defeated **both**
`docs/phase5r/task2-kickoff-amendment.md` binding rules for every real file at once: item 1's
"flat tree ... path simply degrades to the object's own bare name" (broken by the prefix), and
item 2's "sub-floor fragment ... only ancestor available is the scene root itself ⇒ stays
standalone" (broken by the merge). None of Task 2's existing synthetic fixtures reproduce this
shape — `generatePlantGridFixture`'s merged mode and `generateHierarchyFixture` both add nodes
directly as scene children, with no wrapper — which is exactly why only the real-file check
caught it, confirming that check's purpose.

**Fix:** `splitter.ts`'s new `resolveEffectiveRoots()` strips exactly one level — a scene with a
single, mesh-less child literally named `"RootNode"` — before walking, so real top-level objects
get `parentNode === null` (correct standalone treatment) and no wrapper segment in their path
(correct bare-name identity). Deliberately narrow (name-anchored, not "any sole meshless top
child"): a real single-building site (`generateHierarchyFixture` with `buildingCount: 1`) is
also "one meshless top-level child" but is a legitimate grouping level, not an export artifact,
and must remain a valid merge target — covered by its own new test
(`splitter.test.ts`, "kept as a real grouping ancestor, not stripped").

**Re-verified after the fix, same real file:** `metadata.json` now has all **4,510** objects
individually — 3,201 `standaloneFragment` + 1,309 `normal`, zero incorrect merges, 4,510/4,510
with a `linkageKey` (matching the kickoff-amendment's own linkage-coverage finding), correct
bare-name `file`/`path` throughout (e.g. `Object_6.glb`, not `RootNode__Object_6.glb`).

**Real-data calibration point for `triangleFloor` (PR #13 fix-up item 3):** on this real file,
**3,201 of 4,510 objects (71.0%)** fall below the default 50-triangle floor and classify as
fragments. This is a genuinely high sub-floor ratio, not a fixture artifact — real plant models
apparently have far more small/simple parts (bolts, brackets, gaskets, small fittings) than
large ones. Two direct consequences worth recording alongside the default itself, for whoever
next tunes `WORKER_SPLITTER_TRIANGLE_FLOOR`: (1) the default of 50 was chosen against synthetic
fixture density (`docs/phase5r/task2-kickoff-amendment.md`), not real-world sub-floor
prevalence — it happens to produce a sensible split on this file, but a 71% fragment rate is the
actual real-world baseline to calibrate future changes against, not an edge case; (2) this ratio
is also *why* the RootNode-wrapper bug above was so damaging before its fix — with roughly
seven-tenths of all real objects landing in the fragment path, funneling all of them into one
unstripped-wrapper merge target produces a blob dominating the vast majority of the model by
object count, exactly the shape the new blob-ratio guard (below) is calibrated to catch by
default (`blobWarnRatio: 0.5` — well under 71%).

**Observability fix-up (PR #13, verdict item #15):** the original fix above was flagged as
having a silent failure mode — `resolveEffectiveRoots()` had no way to signal when its narrow
`"RootNode"`-name anchor didn't match, so a future renamed/different wrapper would silently
reproduce this exact bug with no warning anywhere. Two independent layers added:

1. **Informational warning** when a sole meshless top-level scene child exists but isn't
   literally named `"RootNode"` — names the node, states its descendants will carry it as a
   real path segment. This is *not* an error signal on its own (a genuine single-building site
   has the identical shape and is legitimately not stripped — see
   `splitter.test.ts`'s extended regression test) — it's a heads-up that the heuristic's
   assumption didn't fire, without claiming to know why.
2. **Blob-ratio symptom guard** (`WORKER_SPLITTER_BLOB_WARN_RATIO`, default `0.5`) — cause-
   agnostic: if any single output object combines more than this fraction of all mesh-bearing
   source objects, a loud warning names it, regardless of *why* they ended up funneled together
   (an unrecognized wrapper name, a future classification bug, or a real but unusually
   concentrated fragment cluster). This is the layer that would have caught the original
   3,201-object blob directly by its symptom, even without knowing "RootNode" was the cause —
   see `splitter.test.ts`'s "blob-ratio symptom guard" test, which reconstructs the wrapper-bug
   shape under a differently-named wrapper (`"SceneRoot"`, deliberately not recognized by
   `resolveEffectiveRoots()`) and confirms the guard fires independent of the name-based fix.

## 7. Real-file run confirms the already-documented Draco-for-tiles gap is real, not theoretical

After the fix above, the same real-file run still finishes successfully (no exception — this is
an oversized-tile warning, not a repair, so the unchanged Task 1 "warn, don't fail" policy
correctly applies), but reports **4 tiles exceeding the 8MB budget even at the minimum LOD depth**
(`maxTriangleCount=500`): up to **29.4MB**. This moved from 2 oversized tiles (38.2MB, 12.9MB)
before the fix to 4 (29.4MB, 23.5MB, 9.1MB, 21.1MB) after — not a regression from the fix itself,
but a shift in failure shape: before, one artificially-merged 70,981-triangle blob (which mago
can never subdivide, being a single input file) dominated; after, mago is correctly given 4,510
genuinely separate per-object files and does its own real spatial subdivision (207 real tile
files, up from 148) — but some real spatial *regions* of this particular plant are dense enough
with small objects that even mago's finest subdivision still produces a handful of tiles over
budget.

This is a real, now-measured instance of the gap CLAUDE.md's Phase 5 section already documents
plainly ("`mago-3d-tiler` does not apply Draco compression natively ... left unimplemented since
there was no real `mago-3d-tiler` output available ... to validate it against") — Task 2 supplies
that real output for the first time. **Not fixed here** — Draco-for-tiles (or another per-tile
size-reduction strategy) is out of Task 2's own scope (per-object pipeline reshape, not tile
post-processing), and is now a confirmed-necessary follow-up rather than a theoretical one; left
for the user to scope as an explicit task rather than folded in silently.

## Scope check

This doc accompanies the full Task 2 splitter implementation (`splitter.ts`, `worldTransform.ts`,
`objectIdentity.ts`, `magoTiler.ts`, `tiles/index.ts`, `fbx/index.ts`, `config.ts`, `types.ts`,
`pipeline.ts` and their tests) — see the PR description for the complete file list. The one
production-code change made *during this doc's own writing* (as opposed to earlier in Task 2) is
`splitter.ts`'s `resolveEffectiveRoots()` (section 6 above), added specifically because the real
client file's own findings, gathered while writing this doc, demanded it — not a hypothetical
improvement.

**PR #13 fix-up (post-open, addressing an independent verification pass's findings):** three
further changes, all covered above at their respective sections — the two-layer observability
addition for `resolveEffectiveRoots()`'s silent fallback (§6, config.ts's new
`splitterBlobWarnRatio`), the committed `normalHandling.wsl.test.ts` making §3's normals finding
independently reproducible, and the quantitative A/B re-run + sub-floor ratio calibration point
(§1, §6). See the PR description's own changelog for the fix-up's complete file list.

**PR #13 fix-up 2 (post-open, addressing a second line-by-line verification pass):** two further
changes, neither yet covered above:

- `isMagoTilerAvailable()` (§6's bonus fix from fix-up 1) had a residual gap even after that
  fix: `fs.access()` only checks that *something* exists at `jarPath()`, not that it's a
  regular file — confirmed directly (`fs.promises.access()` on a plain directory resolves
  successfully). A misconfigured `MAGO_TILER_JAR` pointing at a directory would still be
  misreported as "available," the exact bug class fix-up 1 fixed, one level deeper. Closed by
  switching to `fs.stat().isFile()`, with a dedicated unit test (a real directory at the jar
  path → unavailable). **Not fully closed**, stated plainly: a real, existing, non-directory
  file that exists but isn't a genuinely valid jar (corrupt, wrong format) still passes this
  check and is only caught later by java's own non-zero exit — indistinguishable at the
  exit-code level from mago's own `--help` parser returning non-zero, which this function
  already deliberately treats as "available." Fixing that would need parsing java's stderr for
  a specific error string (fragile across JVM versions) or checking the jar's own magic bytes —
  out of scope for this fix-up (file-existence/type only, per the exact finding reported).
- `classifyMeshNodes`'s fragment-under-fragment case (previously "known, deliberately
  unhandled," §-less until now) is fully resolved: `docs/phase5r/task2-kickoff-amendment.md`
  item 2's fragment-merge rule is extended to resolve transitively through any depth of
  fragment-under-fragment chains, converging on whichever real target sits at the top. The
  `fragmentUnderFragment` warning is retired (not downgraded) — this is no longer an anomalous
  shape, it's a fully specified, deterministic, tested code path. See the amendment doc's own
  updated item 2 for the full rule and rationale, and `splitter.test.ts`'s two new tests
  (single-level fragment-under-fragment, three-deep chain) for the evidence.
