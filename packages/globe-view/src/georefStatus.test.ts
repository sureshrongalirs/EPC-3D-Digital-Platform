import { describe, expect, it } from 'vitest';

import { describeGeorefStatus } from './georefStatus.js';

describe('describeGeorefStatus', () => {
  it('flags an assumed/default placement prominently as unsurveyed', () => {
    const label = describeGeorefStatus({ method: 'assumed', rotationSource: 'default' });
    expect(label).toContain('UNSURVEYED');
    expect(label).toContain('method: assumed');
  });

  it('flags any assumed placement as unsurveyed, even with a set rotation source', () => {
    const label = describeGeorefStatus({ method: 'assumed', rotationSource: 'site_inherited' });
    expect(label).toContain('UNSURVEYED');
  });

  it('does not flag a provided placement as unsurveyed', () => {
    const label = describeGeorefStatus({ method: 'provided', rotationSource: 'model_override' });
    expect(label).not.toContain('UNSURVEYED');
    expect(label).toBe('Custom for this model (method: provided)');
  });

  it('describes a surveyed, site-inherited placement plainly', () => {
    const label = describeGeorefStatus({ method: 'surveyed', rotationSource: 'site_inherited' });
    expect(label).toBe('Site default (method: surveyed)');
  });
});
