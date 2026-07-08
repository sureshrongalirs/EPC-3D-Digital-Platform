import type { ModelInfo, PickResult } from '@plantscope/shared';
import { describe, expect, it, vi } from 'vitest';

import type { PanelSlot, PlantScopePlugin, RestClient, ToolbarSlot } from '../plugin';
// `import type` only — a mock/cast stub stands in for the real Viewer, so this test never
// touches three.js, WebGL, or the DOM (see the note in plugin.ts / pluginHost.ts).
import type { Viewer } from '../Viewer';
import { EventBusImpl } from './eventBus';
import { PluginHost } from './pluginHost';

function createHost() {
  const fakeViewer = {} as Viewer;
  const rest: RestClient = { get: vi.fn(), post: vi.fn(), patch: vi.fn() };
  const events = new EventBusImpl();
  const toolbar: ToolbarSlot = { addButton: vi.fn(), removeButton: vi.fn() };
  const panel: PanelSlot = { addPanel: vi.fn(), removePanel: vi.fn() };
  // Type-only stub (no real DOM created) — keeps this test free of jsdom, same as `fakeViewer`.
  const viewportElement = {} as HTMLElement;
  const host = new PluginHost(fakeViewer, rest, events, toolbar, panel, viewportElement);
  return { host, fakeViewer, rest, events, toolbar, panel, viewportElement };
}

function makePlugin(overrides: Partial<PlantScopePlugin> = {}): PlantScopePlugin {
  return {
    id: 'test-plugin',
    version: '0.0.0',
    onInstall: vi.fn(),
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
    ...overrides,
  };
}

describe('PluginHost', () => {
  it('runs onInstall -> onActivate -> onDeactivate in order', () => {
    const { host } = createHost();
    const calls: string[] = [];
    const plugin = makePlugin({
      onInstall: () => calls.push('install'),
      onActivate: () => calls.push('activate'),
      onDeactivate: () => calls.push('deactivate'),
    });

    host.install(plugin);
    expect(calls).toEqual(['install', 'activate']);

    host.uninstall(plugin.id);
    expect(calls).toEqual(['install', 'activate', 'deactivate']);
  });

  it('passes the facade, rest client, events, and UI slots into onActivate', () => {
    const { host, fakeViewer, rest, events, toolbar, panel, viewportElement } = createHost();
    const onActivate = vi.fn();
    host.install(makePlugin({ onActivate }));

    expect(onActivate).toHaveBeenCalledWith({
      viewer: fakeViewer,
      rest,
      events,
      ui: { toolbar, panel, viewportElement },
    });
  });

  it('passes the facade into onInstall', () => {
    const { host, fakeViewer } = createHost();
    const onInstall = vi.fn();
    host.install(makePlugin({ onInstall }));
    expect(onInstall).toHaveBeenCalledWith(fakeViewer);
  });

  it('throws when installing a plugin id that is already installed', () => {
    const { host } = createHost();
    const plugin = makePlugin();
    host.install(plugin);
    expect(() => host.install(plugin)).toThrow(/already installed/i);
  });

  it('is a no-op to uninstall a plugin id that was never installed', () => {
    const { host } = createHost();
    expect(() => host.uninstall('missing')).not.toThrow();
  });

  it('registers and unregisters contributed toolbar buttons and panels', () => {
    const { host, toolbar, panel } = createHost();
    const buttonSpec = { id: 'btn-1', label: 'Fit', onClick: vi.fn() };
    const panelSpec = { id: 'panel-1', title: 'Zones', render: vi.fn() };
    const plugin = makePlugin({ contributes: { toolbar: [buttonSpec], panels: [panelSpec] } });

    host.install(plugin);
    expect(toolbar.addButton).toHaveBeenCalledWith(buttonSpec);
    expect(panel.addPanel).toHaveBeenCalledWith(panelSpec);

    host.uninstall(plugin.id);
    expect(toolbar.removeButton).toHaveBeenCalledWith('btn-1');
    expect(panel.removePanel).toHaveBeenCalledWith('panel-1');
  });

  it('fires onPick, onModelLoaded, and onZoneCreated hooks on installed plugins only', () => {
    const { host } = createHost();
    const pickSpy = vi.fn();
    const modelLoadedSpy = vi.fn();
    const zoneCreatedSpy = vi.fn();

    const plugin = makePlugin({
      hooks: { onPick: pickSpy, onModelLoaded: modelLoadedSpy, onZoneCreated: zoneCreatedSpy },
    });
    host.install(plugin);

    const pickResult: PickResult = {
      objectId: 'obj-1',
      point: { x: 0, y: 0, z: 0 },
      distance: 1,
      screen: { x: 10, y: 20 },
    };
    host.notifyPick(pickResult);
    expect(pickSpy).toHaveBeenCalledWith(pickResult);

    const modelInfo: ModelInfo = {
      id: 'm1',
      name: 'model',
      format: 'glb',
      objectCount: 1,
      bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    };
    host.notifyModelLoaded(modelInfo);
    expect(modelLoadedSpy).toHaveBeenCalledWith(modelInfo);

    const zone = {
      id: 'z1',
      name: 'Zone A',
      color: '#ff0000',
      members: ['obj-1'],
      footprint: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      zmin: 0,
      zmax: 1,
    };
    host.notifyZoneCreated(zone);
    expect(zoneCreatedSpy).toHaveBeenCalledWith(zone);

    host.uninstall(plugin.id);
    host.notifyPick(pickResult);
    expect(pickSpy).toHaveBeenCalledTimes(1); // not called again after deactivation
  });
});
