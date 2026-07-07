import { describe, expect, it } from 'vitest';

import { getSharedPlaceholder } from './index';

describe('@plantscope/shared placeholder', () => {
  it('exports a placeholder string', () => {
    expect(getSharedPlaceholder()).toBe('PlantScope shared placeholder');
  });
});
