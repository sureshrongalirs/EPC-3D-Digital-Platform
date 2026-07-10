/**
 * Join shape assumed for the legacy `mdb2_to_json` conversion this ports (no machine-readable
 * schema doc ships with the format, so this is the documented, testable contract going
 * forward -- see CSV fixtures under this adapter's *.test.ts for the exact column names):
 *
 *   linkage      (linkage_id, id1, id2, id3, id4, moniker, category)
 *     -- one row per physical object; the 4-integer Linkage key is id1-id2-id3-id4.
 *   labels       (label_id, linkage_id, label_name_id, label_value_id)
 *     -- one row per (object, property) pair.
 *   label_names  (label_name_id, name)
 *   label_values (label_value_id, value)
 *
 * linkage/label_names/label_values are small lookup tables (bounded by object/property-type
 * cardinality, not row count) and are safe to hold fully in memory; `labels` is the table
 * that can run into the millions of rows for an 800MB+ .mdb2 (CLAUDE.md invariant #4) and
 * must be streamed -- see mdb2/ingest.ts, which folds it row-by-row into this join rather
 * than buffering it as an array.
 */

export interface LinkageRow {
  linkage_id: string;
  id1: string;
  id2: string;
  id3: string;
  id4: string;
  moniker: string;
  category: string;
}

export interface LabelRow {
  label_id: string;
  linkage_id: string;
  label_name_id: string;
  label_value_id: string;
}

export interface LabelNameRow {
  label_name_id: string;
  name: string;
}

export interface LabelValueRow {
  label_value_id: string;
  value: string;
}

export interface JoinedComponent {
  linkageKey: string;
  moniker: string | null;
  category: string | null;
  props: Record<string, string>;
}

export function linkageKeyOf(row: LinkageRow): string {
  return `${row.id1}-${row.id2}-${row.id3}-${row.id4}`;
}

/** Incremental accumulator so mdb2/ingest.ts can fold the (potentially huge) `labels` stream
 * in one row at a time without ever materializing the full table as an array -- memory use
 * scales with the number of distinct objects, not the number of label rows. */
export class Mdb2JoinAccumulator {
  private readonly components = new Map<string, JoinedComponent>();

  constructor(
    private readonly linkageById: Map<string, LinkageRow>,
    private readonly labelNameById: Map<string, string>,
    private readonly labelValueById: Map<string, string>,
  ) {}

  addLabel(label: LabelRow): void {
    const linkage = this.linkageById.get(label.linkage_id);
    if (!linkage) return; // orphaned label row; no object to attach it to

    const linkageKey = linkageKeyOf(linkage);
    let component = this.components.get(linkageKey);
    if (!component) {
      component = {
        linkageKey,
        moniker: linkage.moniker || null,
        category: linkage.category || null,
        props: {},
      };
      this.components.set(linkageKey, component);
    }

    const name = this.labelNameById.get(label.label_name_id);
    const value = this.labelValueById.get(label.label_value_id);
    if (name !== undefined && value !== undefined) {
      component.props[name] = value;
    }
  }

  /** Ensures every known object appears in the result even if it has zero label rows
   * (an object with no properties is still a valid component). */
  includeAllLinkages(): void {
    for (const linkage of this.linkageById.values()) {
      const linkageKey = linkageKeyOf(linkage);
      if (!this.components.has(linkageKey)) {
        this.components.set(linkageKey, {
          linkageKey,
          moniker: linkage.moniker || null,
          category: linkage.category || null,
          props: {},
        });
      }
    }
  }

  values(): IterableIterator<JoinedComponent> {
    return this.components.values();
  }

  get size(): number {
    return this.components.size;
  }
}

/** Pure, in-memory join over already-parsed row arrays -- used directly by unit tests
 * against small CSV fixtures. The production streaming path (mdb2/ingest.ts) builds the same
 * result incrementally via Mdb2JoinAccumulator instead of calling this with a fully-buffered
 * `labels` array. */
export function joinMdb2Rows(input: {
  linkage: LinkageRow[];
  labels: LabelRow[];
  labelNames: LabelNameRow[];
  labelValues: LabelValueRow[];
}): JoinedComponent[] {
  const linkageById = new Map(input.linkage.map((r) => [r.linkage_id, r]));
  const labelNameById = new Map(input.labelNames.map((r) => [r.label_name_id, r.name]));
  const labelValueById = new Map(input.labelValues.map((r) => [r.label_value_id, r.value]));

  const acc = new Mdb2JoinAccumulator(linkageById, labelNameById, labelValueById);
  for (const label of input.labels) acc.addLabel(label);
  acc.includeAllLinkages();

  return [...acc.values()];
}
