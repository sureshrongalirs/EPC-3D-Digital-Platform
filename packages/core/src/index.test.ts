import { describe, expect, it } from 'vitest';

import { getCorePlaceholder } from './index';

describe('@plantscope/core placeholder', () => {
  it('exports a placeholder string', () => {
    expect(getCorePlaceholder()).toBe('PlantScope core placeholder');
  });
});
