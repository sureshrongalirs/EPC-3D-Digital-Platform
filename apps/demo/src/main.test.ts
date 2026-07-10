import { GlobeView } from '@plantscope/globe-view';
import { describe, expect, it } from 'vitest';

describe('apps/demo workspace linking', () => {
  it('imports the @plantscope/globe-view GlobeView class', () => {
    // Not instantiated here: GlobeView's constructor needs a real DOM container + WebGL
    // context (see CLAUDE.md / packages/globe-view's headless-friendly test design, which
    // keeps GlobeView itself untested and only unit-tests its pure helpers) which this
    // environment doesn't provide. This still proves the workspace link + build output
    // resolve.
    expect(typeof GlobeView).toBe('function');
  });
});
