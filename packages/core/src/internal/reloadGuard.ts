/**
 * Guards an async continuation against a reload race: `Viewer.loadModel()`/`loadTilesModel()`
 * each have exactly one point where they await something (a georef fetch, tile metadata, the
 * root tileset) with no concurrency guard against a second `loadModel()` call superseding the
 * first while that await is in flight. Re-reading instance state (`this.modelGroup`,
 * `this.tilesRenderer`, ...) after such an await is what actually breaks: PR #14 verification's
 * adversarial pass first found this at the georef-rotation application line, then a follow-up
 * read found that guarding *only* that one line still leaves the identical crash one line
 * later (`buildSceneRegistry(this.modelGroup)`, called unconditionally right after) -- a stale
 * continuation's entire tail, not just its first `this.*` read, is unsafe.
 *
 * `runIfStillCurrent` replaces spot-guarding a single line with abandoning the whole
 * continuation: `continuation` runs (and its result is returned) only if `getCurrent()` still
 * equals the `expected` reference captured before the caller's own await; otherwise this is a
 * silent no-op returning `undefined` -- never a throw, and critically, `continuation` is never
 * even *invoked* when stale, so nothing inside it (a registry rebuild, a `this.*` assignment,
 * an event emit) runs for an abandoned load. This is still a narrow, per-await-site guard, not
 * a general mechanism -- see docs/phase5r/task3-findings.md's Follow-ups section for the real
 * fix (a load-generation counter, naturally absorbed by a future multi-model `ModelManager`).
 */
export function runIfStillCurrent<T, R>(expected: T, getCurrent: () => T, continuation: () => R): R | undefined {
  if (getCurrent() !== expected) return undefined;
  return continuation();
}
