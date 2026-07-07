import type { ComponentRecord } from '@plantscope/shared';
import { describe, expect, it } from 'vitest';

import { resolveLinkage, type LinkageLookupOptions } from './resolveLinkage';

const PUMP_1: ComponentRecord = {
  linkageKey: 'LINK-1001',
  moniker: 'P-101A',
  category: 'Centrifugal Pump',
  tagNumber: 'P-101A',
  status: 'In Service',
};
const PUMP_2: ComponentRecord = {
  linkageKey: 'LINK-1002',
  moniker: 'P-102B',
  category: 'Centrifugal Pump',
  tagNumber: 'P-102B',
  status: 'Standby',
};

const components: Record<string, ComponentRecord> = {
  'LINK-1001': PUMP_1,
  'LINK-1002': PUMP_2,
};

function fetchComponent(linkageKey: string): Promise<ComponentRecord> {
  const component = components[linkageKey];
  if (!component) return Promise.reject(new Error(`no component for ${linkageKey}`));
  return Promise.resolve(component);
}

const options: LinkageLookupOptions = {
  linkageKeyByNodeName: { 'Pump-1': 'LINK-1001' },
  labelIndex: [{ label: 'PUMP-002', linkageKey: 'LINK-1002' }],
};

describe('resolveLinkage', () => {
  it('tier (a): an exact linkage key resolves to a full join', async () => {
    const result = await resolveLinkage('Pump-1', options, fetchComponent, null);
    expect(result).toEqual({ tier: 'full-join', linkageKey: 'LINK-1001', component: PUMP_1 });
  });

  it('tier (b): no key, but the node name fuzzy-matches a label', async () => {
    const result = await resolveLinkage('Pump-2', options, fetchComponent, null);
    expect(result.tier).toBe('fuzzy-match');
    if (result.tier === 'fuzzy-match') {
      expect(result.linkageKey).toBe('LINK-1002');
      expect(result.matchedLabel).toBe('PUMP-002');
      expect(result.component).toEqual(PUMP_2);
    }
  });

  it('tier (c): neither key nor fuzzy match falls back to geometry-only facts', async () => {
    const bbox = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
    const centroid = { x: 0.5, y: 0.5, z: 0.5 };
    const result = await resolveLinkage('Valve-1', options, fetchComponent, { bbox, centroid });
    expect(result).toMatchObject({ tier: 'geometry-only', bbox, centroid });
    if (result.tier === 'geometry-only') {
      expect(result.note).toMatch(/identifier export/i);
    }
  });

  it('falls back to not-found when there is no key, no fuzzy match, and no geometry', async () => {
    const result = await resolveLinkage('Structural-Beam-9', options, fetchComponent, null);
    expect(result).toEqual({ tier: 'not-found' });
  });
});
