import type { ComponentRecord, TileObjectMetadata } from '@plantscope/shared';
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

describe('resolveLinkage tier (c): metadata-record (Task 3 -- tiles-backed models with no components join)', () => {
  const OBJECT_1880: TileObjectMetadata = {
    file: 'Object_1880.glb',
    path: ['Object_1880'],
    name: 'Object_1880',
    kind: 'standaloneFragment',
    linkageKey: '5414 24846 22885 1064',
    triangleCount: 24,
  };
  const MERGED_GROUP: TileObjectMetadata = {
    file: 'Bracket_Group.glb',
    path: ['Bracket_Group'],
    name: 'Bracket_Group',
    kind: 'mergedFragmentGroup',
    triangleCount: 40,
    mergedFrom: [
      { name: 'Bolt_1', linkageKey: 'LINK-9001' },
      { name: 'Bolt_2' },
    ],
  };

  it('resolves via linkageKey when no components-table join exists for it', async () => {
    const optionsWithMetadata: LinkageLookupOptions = {
      ...options,
      metadataByObjectId: { 'Object_1880.glb': OBJECT_1880, '5414 24846 22885 1064': OBJECT_1880 },
    };
    const result = await resolveLinkage('5414 24846 22885 1064', optionsWithMetadata, fetchComponent, null);
    expect(result).toEqual({ tier: 'metadata-record', record: OBJECT_1880 });
  });

  it('resolves via file when there is no linkageKey (linkage coverage is optional)', async () => {
    const optionsWithMetadata: LinkageLookupOptions = {
      ...options,
      metadataByObjectId: { 'Bracket_Group.glb': MERGED_GROUP },
    };
    const result = await resolveLinkage('Bracket_Group.glb', optionsWithMetadata, fetchComponent, null);
    expect(result).toEqual({ tier: 'metadata-record', record: MERGED_GROUP });
  });

  it('is tried only after both components-table tiers miss (order: components match -> metadata record)', async () => {
    const optionsWithBoth: LinkageLookupOptions = {
      ...options, // 'Pump-1' -> LINK-1001 in linkageKeyByNodeName
      metadataByObjectId: { 'Pump-1': OBJECT_1880 },
    };
    const result = await resolveLinkage('Pump-1', optionsWithBoth, fetchComponent, null);
    expect(result).toEqual({ tier: 'full-join', linkageKey: 'LINK-1001', component: PUMP_1 });
  });

  it('falls through to geometry-only when metadataByObjectId has no entry for this nodeName', async () => {
    const bbox = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
    const centroid = { x: 0.5, y: 0.5, z: 0.5 };
    const optionsWithMetadata: LinkageLookupOptions = { ...options, metadataByObjectId: { 'Object_1880.glb': OBJECT_1880 } };
    const result = await resolveLinkage('Unrelated-Object.glb', optionsWithMetadata, fetchComponent, { bbox, centroid });
    expect(result.tier).toBe('geometry-only');
  });
});
