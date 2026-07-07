import type { ComponentRecord } from '@plantscope/shared';
import type { LabelIndexEntry } from '@plantscope/plugins';

import linkageSidecar from './fixtures/multi-object.linkage.json';

// Stands in for a real /api/components/{key} join (Phase 3). Pump-1 resolves via the exact
// linkage key below; Pump-2 only resolves via labelIndex's fuzzy match; Valve-1/Tank-1 have
// neither, exercising LinkageMetadataPlugin's geometry-only tier.
export const mockComponents: ComponentRecord[] = [
  {
    linkageKey: 'LINK-1001',
    moniker: 'P-101A',
    category: 'Centrifugal Pump',
    tagNumber: 'P-101A',
    status: 'In Service',
  },
  {
    linkageKey: 'LINK-1002',
    moniker: 'P-102B',
    category: 'Centrifugal Pump',
    tagNumber: 'P-102B',
    status: 'Standby',
  },
];

export const mockLabelIndex: LabelIndexEntry[] = [{ label: 'PUMP-002', linkageKey: 'LINK-1002' }];

// The sidecar JSON carries a `_comment` field for human readers — strip it before use.
export const linkageKeyByNodeName: Record<string, string> = Object.fromEntries(
  Object.entries(linkageSidecar).filter(([key]) => key !== '_comment'),
);
