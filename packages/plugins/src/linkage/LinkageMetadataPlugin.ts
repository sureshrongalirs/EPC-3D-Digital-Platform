import type { PlantScopePlugin, PluginContext } from '@plantscope/core';
import type { ComponentRecord, ModelInfo, PickResult, TreeNode } from '@plantscope/shared';

import { resolveLinkage, type LinkageLookupOptions, type LinkageLookupResult } from './resolveLinkage';

function flattenTree(root: TreeNode, index: Map<string, string>): void {
  index.set(root.id, root.name);
  for (const child of root.children) flattenTree(child, index);
}

export class LinkageMetadataPlugin implements PlantScopePlugin {
  readonly id = 'plantscope.linkage-metadata';
  readonly version = '0.1.0';

  private ctx: PluginContext | null = null;
  private nodeNameById = new Map<string, string>();
  private currentModel: ModelInfo | null = null;
  private panelEl: HTMLElement | null = null;

  constructor(private readonly options: LinkageLookupOptions) {}

  readonly contributes: PlantScopePlugin['contributes'] = {
    panels: [
      {
        id: 'plantscope.linkage-metadata.panel',
        title: 'Properties',
        render: (container) => {
          this.panelEl = container;
          this.renderPrompt();
        },
      },
    ],
  };

  readonly hooks: PlantScopePlugin['hooks'] = {
    onModelLoaded: (model) => {
      this.currentModel = model;
      this.nodeNameById = this.buildNameIndex();
      this.renderPrompt();
    },
    onPick: (result) => void this.handlePick(result),
  };

  onInstall(): void {
    // No setup needed against the raw Viewer beyond what onActivate's ctx provides.
  }

  onActivate(ctx: PluginContext): void {
    this.ctx = ctx;
  }

  onDeactivate(): void {
    this.ctx = null;
  }

  private buildNameIndex(): Map<string, string> {
    const index = new Map<string, string>();
    if (this.ctx) flattenTree(this.ctx.viewer.getModelTree(), index);
    return index;
  }

  private async handlePick(result: PickResult): Promise<void> {
    if (!this.ctx) return;
    const nodeName = this.nodeNameById.get(result.objectId) ?? result.objectId;
    const bounds = this.ctx.viewer.getObjectBounds(result.objectId);
    const modelId = this.currentModel?.id;

    const lookup = await resolveLinkage(
      nodeName,
      this.options,
      (linkageKey) =>
        this.ctx!.rest.get<ComponentRecord>(`/api/components/${linkageKey}?model=${encodeURIComponent(modelId ?? '')}`),
      bounds,
    );

    this.renderResult(nodeName, lookup);
  }

  private renderPrompt(): void {
    if (!this.panelEl) return;
    this.panelEl.replaceChildren();
    const hint = document.createElement('p');
    hint.textContent = 'Click an object in the viewport to look up its engineering properties.';
    this.panelEl.appendChild(hint);
  }

  private renderResult(nodeName: string, lookup: LinkageLookupResult): void {
    if (!this.panelEl) return;
    this.panelEl.replaceChildren();

    const heading = document.createElement('h4');
    heading.textContent = nodeName;
    this.panelEl.appendChild(heading);

    if (lookup.tier === 'full-join' || lookup.tier === 'fuzzy-match') {
      if (lookup.tier === 'fuzzy-match') {
        const badge = document.createElement('p');
        badge.textContent = `Fuzzy-matched to "${lookup.matchedLabel}" (score ${lookup.score.toFixed(2)})`;
        this.panelEl.appendChild(badge);
      }
      const table = document.createElement('table');
      const rows: [string, string][] = [
        ['Linkage key', lookup.linkageKey],
        ['Moniker', lookup.component.moniker],
        ['Category', lookup.component.category],
        ['Tag number', lookup.component.tagNumber],
        ['Status', lookup.component.status],
      ];
      for (const [label, value] of rows) {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.textContent = label;
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(th, td);
        table.appendChild(tr);
      }
      this.panelEl.appendChild(table);
      return;
    }

    if (lookup.tier === 'geometry-only') {
      const size = {
        x: lookup.bbox.max.x - lookup.bbox.min.x,
        y: lookup.bbox.max.y - lookup.bbox.min.y,
        z: lookup.bbox.max.z - lookup.bbox.min.z,
      };
      const fmt = (n: number) => n.toFixed(2);
      const facts = document.createElement('ul');
      const items = [
        `Size: ${fmt(size.x)} x ${fmt(size.y)} x ${fmt(size.z)}`,
        `Center: (${fmt(lookup.centroid.x)}, ${fmt(lookup.centroid.y)}, ${fmt(lookup.centroid.z)})`,
      ];
      for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        facts.appendChild(li);
      }
      this.panelEl.appendChild(facts);

      const note = document.createElement('p');
      note.textContent = lookup.note;
      this.panelEl.appendChild(note);
      return;
    }

    const notFound = document.createElement('p');
    notFound.textContent = 'No engineering data or geometry available for this object.';
    this.panelEl.appendChild(notFound);
  }
}

export function createLinkageMetadataPlugin(options: LinkageLookupOptions): LinkageMetadataPlugin {
  return new LinkageMetadataPlugin(options);
}
