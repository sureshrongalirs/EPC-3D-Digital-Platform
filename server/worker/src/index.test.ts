import { describe, expect, it } from 'vitest';

import { getWorkerPlaceholder } from './index.js';

describe('@plantscope/worker placeholder', () => {
  it('exports a placeholder string', () => {
    expect(getWorkerPlaceholder()).toBe('PlantScope worker placeholder');
  });
});
