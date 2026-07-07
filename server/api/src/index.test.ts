import { describe, expect, it } from 'vitest';

import { getApiPlaceholder } from './index.js';

describe('@plantscope/api placeholder', () => {
  it('exports a placeholder string', () => {
    expect(getApiPlaceholder()).toBe('PlantScope api placeholder');
  });
});
