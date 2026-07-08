import type { LabelIndexEntry } from '@plantscope/plugins';

import linkageSidecar from './fixtures/multi-object.linkage.json';

// LinkageMetadataPlugin's tier (a)/(b) inputs — which linkage key to look up, and which
// label to fuzzy-match against, independent of whether the API has that component yet.
// Until Phase 4's worker actually populates the `components` table, every lookup here
// still falls through to the geometry-only tier (no seeding endpoint exists in Phase 3) —
// expected, not a bug; see the PR's manual walkthrough.
export const mockLabelIndex: LabelIndexEntry[] = [{ label: 'PUMP-002', linkageKey: 'LINK-1002' }];

// The sidecar JSON carries a `_comment` field for human readers — strip it before use.
export const linkageKeyByNodeName: Record<string, string> = Object.fromEntries(
  Object.entries(linkageSidecar).filter(([key]) => key !== '_comment'),
);
