# Phase 5R Task 2 kickoff amendment — real-file findings, pre-Task-2

**Date:** 2026-07-15
**Source:** independent verification pass during PR #11/#12 review, inspecting a real client
file (`2 1.fbx`, `testdata/local/2 1.fbx` — git-ignored per CLAUDE.md invariant #8) end to end
through `assimp export` and both `@gltf-transform/cli inspect` and this repo's own
`parseFBXLinkages`/`parseFBXBinary`. Captured here, before Task 2 branches, so these findings
and the decisions they drove aren't left sitting in a chat transcript.

## 1. Real-file inspection summary (`2 1.fbx` → merged GLB)

- **4,510 uniquely named objects** (`Object_6`, `Object_8`, `Object_9`, ... — non-contiguous
  numbering, all distinct).
- **Names round-trip assimp exactly.** The FBX source's `Model` node names and the
  assimp-exported GLB's node names are identical, 1:1, in the same order — confirmed by
  listing the first 20 from each side directly (this repo's own `parseFBXBinary`/
  `parseFBXLinkages` on the FBX side, `@gltf-transform/core` walking the real node tree, not
  just the mesh table, on the GLB side). Assimp does not rename or renumber.
- **4,510 / 4,510 objects carry a Linkage key** (`parseFBXLinkages` recovers one for every
  single `Model` node in this file — the linkage-optional policy still applies in general, but
  this particular file has full coverage).
- **The tree is flat.** Every `Model` node connects directly to the FBX scene root via a single
  `OO`-type `Connections` edge — zero intermediate group/null nodes. The exported GLB mirrors
  this exactly: `RootNode -> 4,510 leaf mesh nodes`, depth distribution `{1: 1, 2: 4510}`
  (`RootNode` itself at depth 1, every object at depth 2). No nesting anywhere in this file.
- **54.0 MB FBX -> 69.5 MB assimp-exported GLB.**
- **All 4,510 materials are `OPAQUE`; zero textures; zero animations.**

## 2. Decisions binding on Task 2

- **Identity stays the full hierarchy path, as originally specced** (Task 2 item 1's
  "deterministic, filesystem-safe encoding of the node's hierarchy path"). No special-casing
  for flat input: on a flat tree the path simply degrades to the object's own bare name, which
  is exactly what should happen — no separate code path needed.
- **Flat trees are a confirmed real-world shape, not a synthetic edge case.** Task 2's splitter
  unit tests must exercise **both** fixture generators, not just the new one:
  - `testdata/scripts/generate-plant-grid-fixture.mjs`'s `generatePlantGridFixture(...,
    'merged', ...)` (Task 0, already merged) — flat: one scene root, N leaf objects, zero
    intermediate grouping. This is the shape `2 1.fbx` actually has.
  - `generateHierarchyFixture(...)` (this PR, #12) — nested: 4-level-deep
    Building/Floor/Room/leaf hierarchy with duplicate names under different parents. Still a
    necessary test case (real files *can* be nested — this is the identity-collision stress
    test), just not the only shape to cover.
- **Fragment merge rule, made explicit:** a sub-floor fragment merges into its **nearest named
  ancestor**. When the only ancestor available is the scene root itself, the fragment stays
  **standalone** — it is never merged into the root, never merged into a sibling, and never
  dropped. Root-level tiny objects can be real, individually-linkage-keyed plant parts (bolts,
  brackets, gaskets — see the fragment naming convention `generateHierarchyFixture` already
  uses) and must keep their own identity and their own metadata record. This is a hard
  requirement for Task 2's splitter, with its own dedicated unit test in that task's suite: a
  flat tree, a sub-floor leaf directly under the root, asserting it survives as its own output
  file with its own metadata record rather than being silently absorbed or discarded.
- **FBX compound node names use a `\x00\x01` (NUL+SOH) separator**, not a printable character.
  Any code that compares or splits these names must do so byte-exact against the literal
  `\x00\x01` sequence — never by eyeballing a rendered/terminal-displayed version of the string,
  which shows both control bytes as indistinguishable blank space. This already produced one
  wrong conclusion during this verification pass (a manual re-implementation of
  `splitCompoundName` used a literal space and appeared to disagree with the real
  `parseFBXLinkages` output, until `od -c` on the compiled source confirmed the true separator
  bytes) before being caught and corrected against the real parser's actual behavior.

## 3. Manual verification target

`2 1.fbx`'s 4,510 objects sit **just below** Task 0's confirmed ~4,750-object merged-mode crash
threshold for mago-3d-tiler (`docs/phase5r/task0-findings.md`) — real enough to be a
representative production file, but not so large that it hits that specific known failure mode
on its own. This file is the designated **end-of-Task-2 manual verification article**: once the
splitter is implemented, running the full pipeline against `2 1.fbx` (routed to the split path,
which Task 2 makes real) is the concrete check that Task 2 actually worked end to end against
production-scale real data, not just synthetic fixtures.
