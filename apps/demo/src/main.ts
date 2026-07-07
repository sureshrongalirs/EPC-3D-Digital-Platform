import type { PickResult } from '@plantscope/core';
import { Viewer } from '@plantscope/core';
import { createLinkageMetadataPlugin, createMapGeorefPlugin, createMockRestClient, createZonesPlugin } from '@plantscope/plugins';

import { linkageKeyByNodeName, mockComponents, mockLabelIndex } from './mockData';

function required<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`demo: missing required element "${selector}"`);
  return el;
}

const viewerContainer = required<HTMLDivElement>('#viewer');
const fileInput = required<HTMLInputElement>('#file-input');
const fitBtn = required<HTMLButtonElement>('#fit-btn');
const isolateBtn = required<HTMLButtonElement>('#isolate-btn');
const showAllBtn = required<HTMLButtonElement>('#show-all-btn');
const log = required<HTMLPreElement>('#log');

function appendLog(message: string): void {
  const time = new Date().toLocaleTimeString();
  log.textContent = `${time}  ${message}\n${log.textContent ?? ''}`;
}

// No real API server exists until Phase 3 — this in-memory mock stands in behind the same
// RestClient interface every plugin uses via PluginContext.rest.
const mockRestClient = createMockRestClient({ components: mockComponents });

const viewer = new Viewer(viewerContainer, { restClient: mockRestClient });

viewer.use(createZonesPlugin());
viewer.use(createMapGeorefPlugin());
viewer.use(
  createLinkageMetadataPlugin({
    linkageKeyByNodeName,
    labelIndex: mockLabelIndex,
  }),
);

let lastPickedId: string | null = null;

viewer.on('pick', (...args: unknown[]) => {
  const result = args[0] as PickResult;
  lastPickedId = result.objectId;
  viewer.highlight([result.objectId]);
  appendLog(`pick -> ${JSON.stringify(result)}`);
});

async function loadFile(file: File): Promise<void> {
  appendLog(`loading ${file.name}...`);
  try {
    const buffer = await file.arrayBuffer();
    const modelInfo = await viewer.loadModel(buffer);
    appendLog(`loaded "${modelInfo.name}": ${modelInfo.objectCount} objects`);
  } catch (err) {
    appendLog(`failed to load ${file.name}: ${(err as Error).message}`);
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});

// Drag-drop is attached to the viewer container itself (not a covering overlay) so it
// never blocks pointer events needed for pick().
viewerContainer.addEventListener('dragover', (event) => {
  event.preventDefault();
});
viewerContainer.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});
// Prevent the browser from navigating to the dropped file if it misses the container.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

fitBtn.addEventListener('click', () => viewer.fitToModel());
isolateBtn.addEventListener('click', () => {
  if (lastPickedId) viewer.isolate([lastPickedId]);
});
showAllBtn.addEventListener('click', () => viewer.showAll());
