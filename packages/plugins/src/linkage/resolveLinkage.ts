import { findBestTrigramMatch, type BoundingBox, type ComponentRecord, type Vector3Like } from '@plantscope/shared';

export interface LabelIndexEntry {
  label: string;
  linkageKey: string;
}

export interface LinkageLookupOptions {
  /** Per-model node-name -> linkage key map, loaded from a JSON sidecar in testdata/. */
  linkageKeyByNodeName: Record<string, string>;
  /** Fuzzy-match candidates for tier (b) when no exact linkage key is found. */
  labelIndex: LabelIndexEntry[];
  fuzzyThreshold?: number;
}

export type LinkageLookupResult =
  | { tier: 'full-join'; linkageKey: string; component: ComponentRecord }
  | {
      tier: 'fuzzy-match';
      linkageKey: string;
      component: ComponentRecord;
      matchedLabel: string;
      score: number;
    }
  | { tier: 'geometry-only'; bbox: BoundingBox; centroid: Vector3Like; note: string }
  | { tier: 'not-found' };

const DEFAULT_FUZZY_THRESHOLD = 0.35;
const GEOMETRY_ONLY_NOTE =
  'No linkage key or fuzzy label match — enable identifier export in the source tool to join engineering data.';

/**
 * Degradation tiers, in order: (a) exact linkage key -> full join; (b) no key, but the node
 * name fuzzy-matches a mock label (trigram similarity) -> matched join; (c) neither ->
 * geometry-only facts. Pure aside from `fetchComponent`, so it's unit-testable without a
 * real PluginContext — see resolveLinkage.test.ts.
 */
export async function resolveLinkage(
  nodeName: string,
  options: LinkageLookupOptions,
  fetchComponent: (linkageKey: string) => Promise<ComponentRecord>,
  geometryFacts: { bbox: BoundingBox; centroid: Vector3Like } | null,
): Promise<LinkageLookupResult> {
  const exactKey = options.linkageKeyByNodeName[nodeName];
  if (exactKey) {
    try {
      const component = await fetchComponent(exactKey);
      return { tier: 'full-join', linkageKey: exactKey, component };
    } catch {
      // No component behind that key after all — fall through to the next tier.
    }
  }

  const threshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
  const match = findBestTrigramMatch(nodeName, options.labelIndex, (entry) => entry.label, threshold);
  if (match) {
    try {
      const component = await fetchComponent(match.candidate.linkageKey);
      return {
        tier: 'fuzzy-match',
        linkageKey: match.candidate.linkageKey,
        component,
        matchedLabel: match.candidate.label,
        score: match.score,
      };
    } catch {
      // Matched label's key doesn't resolve either — fall through to geometry-only.
    }
  }

  if (geometryFacts) {
    return { tier: 'geometry-only', ...geometryFacts, note: GEOMETRY_ONLY_NOTE };
  }

  return { tier: 'not-found' };
}
