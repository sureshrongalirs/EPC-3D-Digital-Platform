import { describe, expect, it } from 'vitest';

import { getPluginsPlaceholder } from './index';

describe('@plantscope/plugins placeholder', () => {
  it('exports a placeholder string', () => {
    expect(getPluginsPlaceholder()).toBe('PlantScope plugins placeholder');
  });
});
