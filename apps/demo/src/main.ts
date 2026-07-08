import type { PickResult } from '@plantscope/core';
import { Viewer } from '@plantscope/core';
import { createLinkageMetadataPlugin, createMapGeorefPlugin, createZonesPlugin } from '@plantscope/plugins';

import { linkageKeyByNodeName, mockLabelIndex } from './mockData';

interface ModelSummary {
  id: string;
  name: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  artifactUrl: string | null;
}

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

// Phase 3: talks to the real server/api over relative paths (see vite.config.ts's dev
// proxy) — no more in-memory mock RestClient. mockComponents/mockLabelIndex stay for
// LinkageMetadataPlugin's fuzzy-match tier only (the API doesn't do label search itself).
const viewer = new Viewer(viewerContainer, {});

viewer.use(createZonesPlugin());
viewer.use(createMapGeorefPlugin());
viewer.use(
  createLinkageMetadataPlugin({
    linkageKeyByNodeName,
    labelIndex: mockLabelIndex,
  }),
);

async function loadNewestReadyModel(): Promise<void> {
  try {
    const models = (await (await fetch('/api/models')).json()) as ModelSummary[];
    const newestReady = models.find((m) => m.status === 'ready' && m.artifactUrl);
    if (!newestReady?.artifactUrl) {
      appendLog('no ready model in the catalog yet — upload one below.');
      return;
    }
    appendLog(`auto-loading newest ready model "${newestReady.name}"...`);
    const modelInfo = await viewer.loadModel(newestReady.artifactUrl);
    appendLog(`loaded "${modelInfo.name}": ${modelInfo.objectCount} objects`);
  } catch (err) {
    appendLog(`failed to reach the API: ${(err as Error).message}`);
  }
}
void loadNewestReadyModel();

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
