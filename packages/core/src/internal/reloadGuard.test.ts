import { describe, expect, it, vi } from 'vitest';

import { runIfStillCurrent } from './reloadGuard';

describe('runIfStillCurrent (PR #14 verification fix-up 3 -- full-continuation reload-race guard)', () => {
  it('runs the continuation and returns its result when nothing superseded the reference', () => {
    const expected = { id: 'A' };
    const continuation = vi.fn(() => 'ran');
    const result = runIfStillCurrent(expected, () => expected, continuation);
    expect(result).toBe('ran');
    expect(continuation).toHaveBeenCalledTimes(1);
  });

  it('simulates the exact race from finding (f): load A starts, load B supersedes A mid-await, A resolves last -- the continuation is never invoked at all, not just its rotation step', () => {
    let current: { id: string } = { id: 'A' };
    const groupA = current;
    const groupB = { id: 'B' };

    // Stands in for Viewer.loadModel()'s own `finish()` closure: applies a rotation AND
    // simulates the other work finding (f) showed was left unguarded by the earlier
    // spot-guard (buildSceneRegistry-equivalent, modelInfo construction, the modelLoaded
    // emit, fitToModel). Rotation-only assertions from the previous fix-up round stay --
    // see the two `rotationApplied`/`registryBuilt`/... spies checked individually below.
    let rotationApplied = false;
    const buildRegistry = vi.fn();
    const emitModelLoaded = vi.fn();
    const fitToModel = vi.fn();

    const continuation = vi.fn(() => {
      rotationApplied = true;
      buildRegistry();
      const modelInfo = { id: 'A', objectCount: 1 };
      fitToModel();
      emitModelLoaded(modelInfo);
      return modelInfo;
    });

    // Load A "starts": it already captured `groupA` as its expected reference before
    // whatever async gap it's about to await on (georef fetch / tile metadata / etc.) --
    // exactly Viewer.loadModel()'s `const loadedGroup = this.modelGroup;` before its await.
    // Load B then supersedes it (its own unloadModel() + fresh assignment) while A's await
    // is still pending -- modeled here by just mutating `current` directly, since the actual
    // async gap itself isn't runIfStillCurrent's concern (it runs strictly after the
    // caller's own await already resolved).
    current = groupB;

    const result = runIfStillCurrent(groupA, () => current, continuation);

    expect(result).toBeUndefined(); // no throw, no fabricated ModelInfo for the losing load
    expect(continuation).not.toHaveBeenCalled(); // the WHOLE continuation, not just a rotation line

    // Rotation-only assertion, preserved from the previous fix-up round's race test.
    expect(rotationApplied).toBe(false);
    // Finding (f)'s own gap, now closed: none of the previously-unguarded downstream work
    // ran either.
    expect(buildRegistry).not.toHaveBeenCalled();
    expect(emitModelLoaded).not.toHaveBeenCalled();
    expect(fitToModel).not.toHaveBeenCalled();
  });

  it('never throws when getCurrent returns null (e.g. a concurrent unloadModel() with no new load started yet)', () => {
    const expected = { id: 'A' };
    const continuation = vi.fn();
    const result = runIfStillCurrent(expected, () => null, continuation);
    expect(result).toBeUndefined();
    expect(continuation).not.toHaveBeenCalled();
  });
});
