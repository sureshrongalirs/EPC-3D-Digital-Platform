import { describe, expect, it } from 'vitest';

import { getCorePlaceholder } from '@plantscope/core';

describe('apps/demo workspace linking', () => {
  it('imports the @plantscope/core placeholder', () => {
    expect(getCorePlaceholder()).toBe('PlantScope core placeholder');
  });
});
