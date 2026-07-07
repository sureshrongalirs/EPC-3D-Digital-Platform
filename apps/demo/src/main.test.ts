import { Viewer } from '@plantscope/core';
import { describe, expect, it } from 'vitest';

describe('apps/demo workspace linking', () => {
  it('imports the @plantscope/core Viewer class', () => {
    // Not instantiated here: Viewer's constructor needs a real WebGL context (see
    // CLAUDE.md / packages/core's headless-friendly test design) which this environment
    // doesn't provide. This still proves the workspace link + build output resolve.
    expect(typeof Viewer).toBe('function');
  });
});
