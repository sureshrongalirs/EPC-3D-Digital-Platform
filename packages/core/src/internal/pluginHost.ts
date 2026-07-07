import type { ModelInfo, PickResult, Zone } from '@plantscope/shared';

import type { EventBus, PanelSlot, PlantScopePlugin, PluginContext, RestClient, ToolbarSlot } from '../plugin';
// `import type` only — see plugin.ts's note on why this never pulls three.js into tests
// that construct a PluginHost with a mock facade.
import type { Viewer } from '../Viewer';

interface PluginEntry {
  plugin: PlantScopePlugin;
}

/**
 * Manages the plugins install -> activate -> deactivate lifecycle and dispatches hooks.
 * Depends only on interfaces (RestClient/EventBus/ToolbarSlot/PanelSlot), so it can be
 * constructed and tested without a real Viewer, DOM, or three.js — see internal/pluginHost.test.ts.
 */
export class PluginHost {
  private readonly plugins = new Map<string, PluginEntry>();

  constructor(
    private readonly facade: Viewer,
    private readonly rest: RestClient,
    private readonly events: EventBus,
    private readonly toolbar: ToolbarSlot,
    private readonly panel: PanelSlot,
  ) {}

  install(plugin: PlantScopePlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" is already installed`);
    }

    plugin.onInstall(this.facade);

    const ctx: PluginContext = {
      viewer: this.facade,
      rest: this.rest,
      events: this.events,
      ui: { toolbar: this.toolbar, panel: this.panel },
    };
    plugin.onActivate(ctx);

    for (const spec of plugin.contributes?.toolbar ?? []) {
      this.toolbar.addButton(spec);
    }
    for (const spec of plugin.contributes?.panels ?? []) {
      this.panel.addPanel(spec);
    }

    this.plugins.set(plugin.id, { plugin });
  }

  uninstall(pluginId: string): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;

    for (const spec of entry.plugin.contributes?.toolbar ?? []) {
      this.toolbar.removeButton(spec.id);
    }
    for (const spec of entry.plugin.contributes?.panels ?? []) {
      this.panel.removePanel(spec.id);
    }

    entry.plugin.onDeactivate();
    this.plugins.delete(pluginId);
  }

  disposeAll(): void {
    for (const id of [...this.plugins.keys()]) {
      this.uninstall(id);
    }
  }

  notifyPick(result: PickResult): void {
    for (const { plugin } of this.plugins.values()) {
      plugin.hooks?.onPick?.(result);
    }
  }

  notifyModelLoaded(model: ModelInfo): void {
    for (const { plugin } of this.plugins.values()) {
      plugin.hooks?.onModelLoaded?.(model);
    }
  }

  notifyZoneCreated(zone: Zone): void {
    for (const { plugin } of this.plugins.values()) {
      plugin.hooks?.onZoneCreated?.(zone);
    }
  }
}
