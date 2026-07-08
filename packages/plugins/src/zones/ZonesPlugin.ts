import type { PlantScopePlugin, PluginContext } from '@plantscope/core';
import type { BoundingBox, ModelInfo, Zone } from '@plantscope/shared';

import { selectObjectsInRect, type ScreenRect } from './boxSelect';
import { computeZoneBoundary } from './zoneBoundary';

/**
 * ZonesPlugin's zones follow a three-layer model:
 *  - definition:  how membership was captured — here, one or more box-select drags
 *                 (ephemeral; not persisted, just drives the capture workflow below).
 *  - boundary:    derived geometry — {@link computeZoneBoundary}'s footprint/zmin/zmax,
 *                 recomputed from members whenever they change.
 *  - members:     the resolved objectId[] list — resolved once per capture and cached on
 *                 the Zone record until add-members/remove-member changes it.
 */
export interface ZonesPluginApi {
  startCreateZone(name: string, color: string): void;
  startAddMembers(zoneId: string): void;
  removeMember(zoneId: string, objectId: string): Promise<Zone | null>;
  renameZone(zoneId: string, name: string): Promise<Zone | null>;
  recolorZone(zoneId: string, color: string): Promise<Zone | null>;
  deleteZone(zoneId: string): Promise<void>;
  zoomToZone(zoneId: string): void;
  isolateZone(zoneId: string): void;
  colorizeZone(zoneId: string): void;
  listZones(): Zone[];
  onChange(handler: () => void): () => void;
}

const DRAG_THRESHOLD_PX = 4;

export class ZonesPlugin implements PlantScopePlugin {
  readonly id = 'plantscope.zones';
  readonly version = '0.1.0';

  private ctx: PluginContext | null = null;
  private currentModel: ModelInfo | null = null;
  private zones = new Map<string, Zone>();
  private changeListeners = new Set<() => void>();

  private pendingCapture: { name: string; color: string; appendToZoneId?: string } | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private selectionBox: HTMLDivElement | null = null;

  readonly contributes: PlantScopePlugin['contributes'] = {
    panels: [
      {
        id: 'plantscope.zones.panel',
        title: 'Zones',
        render: (container) => this.renderPanel(container),
      },
    ],
  };

  readonly hooks: PlantScopePlugin['hooks'] = {
    onModelLoaded: (model) => {
      this.currentModel = model;
      this.zones.clear();
      void this.loadZones();
    },
  };

  onInstall(): void {
    // No setup needed against the raw Viewer beyond what onActivate's ctx provides.
  }

  onActivate(ctx: PluginContext): void {
    this.ctx = ctx;
    ctx.ui.viewportElement.addEventListener('pointerdown', this.handlePointerDown);
  }

  onDeactivate(): void {
    this.ctx?.ui.viewportElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.ctx = null;
    this.changeListeners.clear();
  }

  /** Programmatic API — the demo's panel UI is just the first consumer of this. */
  get api(): ZonesPluginApi {
    return {
      startCreateZone: (name, color) => {
        this.pendingCapture = { name, color };
      },
      startAddMembers: (zoneId) => {
        const zone = this.zones.get(zoneId);
        if (!zone) return;
        this.pendingCapture = { name: zone.name, color: zone.color, appendToZoneId: zoneId };
      },
      removeMember: (zoneId, objectId) => this.removeMember(zoneId, objectId),
      renameZone: (zoneId, name) => this.updateZone(zoneId, (z) => ({ ...z, name })),
      recolorZone: (zoneId, color) => this.updateZone(zoneId, (z) => ({ ...z, color })),
      deleteZone: (zoneId) => this.deleteZone(zoneId),
      zoomToZone: (zoneId) => this.withZone(zoneId, (z) => this.ctx?.viewer.zoomToObjects(z.members)),
      isolateZone: (zoneId) => this.withZone(zoneId, (z) => this.ctx?.viewer.isolate(z.members)),
      colorizeZone: (zoneId) => this.withZone(zoneId, (z) => this.ctx?.viewer.colorize(z.members, z.color)),
      listZones: () => [...this.zones.values()],
      onChange: (handler) => {
        this.changeListeners.add(handler);
        return () => this.changeListeners.delete(handler);
      },
    };
  }

  private withZone(zoneId: string, fn: (zone: Zone) => void): void {
    const zone = this.zones.get(zoneId);
    if (zone) fn(zone);
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  private async loadZones(): Promise<void> {
    if (!this.ctx || !this.currentModel) return;
    try {
      const zones = await this.ctx.rest.get<Zone[]>(`/api/zones?model=${encodeURIComponent(this.currentModel.id)}`);
      for (const zone of zones) this.zones.set(zone.id, zone);
      this.notifyChange();
    } catch {
      // No zones persisted yet (or no backing RestClient) — starting empty is fine.
    }
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.pendingCapture || !this.ctx || event.button !== 0) return;

    const rect = this.ctx.ui.viewportElement.getBoundingClientRect();
    this.dragStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.ctx.viewer.setOrbitEnabled(false);

    this.selectionBox = document.createElement('div');
    Object.assign(this.selectionBox.style, {
      position: 'absolute',
      border: '1px dashed #2a7fff',
      background: 'rgba(42, 127, 255, 0.15)',
      pointerEvents: 'none',
      zIndex: '20',
    });
    this.ctx.ui.viewportElement.appendChild(this.selectionBox);

    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.dragStart || !this.selectionBox || !this.ctx) return;
    const rect = this.ctx.ui.viewportElement.getBoundingClientRect();
    const current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const x = Math.min(this.dragStart.x, current.x);
    const y = Math.min(this.dragStart.y, current.y);
    Object.assign(this.selectionBox.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${Math.abs(current.x - this.dragStart.x)}px`,
      height: `${Math.abs(current.y - this.dragStart.y)}px`,
    });
  };

  private handlePointerUp = (event: PointerEvent): void => {
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    this.ctx?.viewer.setOrbitEnabled(true);
    this.selectionBox?.remove();
    this.selectionBox = null;

    const dragStart = this.dragStart;
    this.dragStart = null;
    if (!dragStart || !this.ctx || !this.pendingCapture) return;

    const rect = this.ctx.ui.viewportElement.getBoundingClientRect();
    const end = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const screenRect: ScreenRect = { x1: dragStart.x, y1: dragStart.y, x2: end.x, y2: end.y };

    if (
      Math.abs(screenRect.x2 - screenRect.x1) < DRAG_THRESHOLD_PX ||
      Math.abs(screenRect.y2 - screenRect.y1) < DRAG_THRESHOLD_PX
    ) {
      this.pendingCapture = null; // too small to be a deliberate drag
      return;
    }

    const centroids = this.ctx.viewer.getObjectScreenCentroids();
    const captured = selectObjectsInRect(centroids, screenRect);
    void this.commitCapture(captured);
  };

  private async commitCapture(capturedIds: string[]): Promise<void> {
    const pending = this.pendingCapture;
    this.pendingCapture = null;
    if (!this.ctx || !pending || !this.currentModel) return;

    const existing = pending.appendToZoneId ? this.zones.get(pending.appendToZoneId) : undefined;
    const members = Array.from(new Set([...(existing?.members ?? []), ...capturedIds]));
    const boundary = this.computeBoundary(members);

    const zone: Zone = {
      id: existing?.id ?? '',
      name: existing?.name ?? pending.name,
      color: existing?.color ?? pending.color,
      members,
      footprint: boundary.footprint,
      zmin: boundary.zmin,
      zmax: boundary.zmax,
    };

    const saved = await this.postZone(zone);
    if (!saved) return;
    this.ctx.events.emit('zoneCreated', saved);
    this.notifyChange();
  }

  /** Every POST /api/zones call needs modelId — the persisted Zone shape doesn't carry one. */
  private async postZone(zone: Zone): Promise<Zone | null> {
    if (!this.ctx || !this.currentModel) return null;
    const saved = await this.ctx.rest.post<Zone>('/api/zones', { ...zone, modelId: this.currentModel.id });
    this.zones.set(saved.id, saved);
    return saved;
  }

  private computeBoundary(memberIds: string[]) {
    const bboxes: BoundingBox[] = [];
    for (const id of memberIds) {
      const bounds = this.ctx?.viewer.getObjectBounds(id);
      if (bounds) bboxes.push(bounds.bbox);
    }
    return computeZoneBoundary(bboxes);
  }

  private async removeMember(zoneId: string, objectId: string): Promise<Zone | null> {
    const zone = this.zones.get(zoneId);
    if (!zone) return null;
    const members = zone.members.filter((id) => id !== objectId);
    return this.persistZoneUpdate({ ...zone, members, ...this.computeBoundary(members) });
  }

  private async updateZone(zoneId: string, updater: (zone: Zone) => Zone): Promise<Zone | null> {
    const zone = this.zones.get(zoneId);
    if (!zone) return null;
    return this.persistZoneUpdate(updater(zone));
  }

  private async persistZoneUpdate(zone: Zone): Promise<Zone | null> {
    const saved = await this.postZone(zone);
    this.notifyChange();
    return saved;
  }

  private async deleteZone(zoneId: string): Promise<void> {
    if (!this.ctx) return;
    await this.ctx.rest.post(`/api/zones/${zoneId}/delete`, {});
    this.zones.delete(zoneId);
    this.notifyChange();
  }

  private renderPanel(container: HTMLElement): void {
    const form = document.createElement('div');
    const nameInput = document.createElement('input');
    nameInput.placeholder = 'Zone name';
    nameInput.value = 'New zone';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = '#2a7fff';
    const startButton = document.createElement('button');
    startButton.type = 'button';
    startButton.textContent = 'Box-select (drag on viewport)';
    startButton.addEventListener('click', () => this.api.startCreateZone(nameInput.value, colorInput.value));
    form.append(nameInput, colorInput, startButton);

    const list = document.createElement('ul');
    const renderList = (): void => {
      list.replaceChildren();
      for (const zone of this.zones.values()) {
        list.appendChild(this.renderZoneRow(zone));
      }
    };

    const unsubscribe = this.api.onChange(renderList);
    // PanelSlot never calls a teardown hook, so drop the listener when the panel's own DOM
    // node is removed from the document (happens on onDeactivate's uninstall path).
    new MutationObserver(() => {
      if (!container.isConnected) unsubscribe();
    }).observe(container.parentElement ?? container, { childList: true });

    renderList();
    container.append(form, list);
  }

  private renderZoneRow(zone: Zone): HTMLLIElement {
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    Object.assign(swatch.style, {
      display: 'inline-block',
      width: '10px',
      height: '10px',
      marginRight: '4px',
      background: zone.color,
    });
    const label = document.createElement('strong');
    label.textContent = `${zone.name} (${zone.members.length})`;

    const button = (text: string, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.addEventListener('click', onClick);
      return btn;
    };

    const rename = button('Rename', () => {
      const name = window.prompt('Zone name', zone.name);
      if (name) void this.api.renameZone(zone.id, name);
    });
    const recolor = button('Recolor', () => {
      const color = window.prompt('Zone color (hex)', zone.color);
      if (color) void this.api.recolorZone(zone.id, color);
    });
    const addMembers = button('Add members', () => this.api.startAddMembers(zone.id));
    const removeMember = button('Remove member', () => {
      const objectId = window.prompt(`Remove which object id?\n${zone.members.join(', ')}`);
      if (objectId) void this.api.removeMember(zone.id, objectId);
    });
    const zoomTo = button('Zoom', () => this.api.zoomToZone(zone.id));
    const isolate = button('Isolate', () => this.api.isolateZone(zone.id));
    const colorize = button('Colorize', () => this.api.colorizeZone(zone.id));
    const del = button('Delete', () => void this.api.deleteZone(zone.id));

    li.append(swatch, label, rename, recolor, addMembers, removeMember, zoomTo, isolate, colorize, del);
    return li;
  }
}

export function createZonesPlugin(): ZonesPlugin {
  return new ZonesPlugin();
}
