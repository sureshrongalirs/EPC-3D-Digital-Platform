import type { PickResult } from '@plantscope/core';
import { Viewer } from '@plantscope/core';
import { GlobeView } from '@plantscope/globe-view';
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
const globeContainer = required<HTMLDivElement>('#globe-container');
const tab2dBtn = required<HTMLButtonElement>('#tab-2d-btn');
const tabGlobeBtn = required<HTMLButtonElement>('#tab-globe-btn');
const fileInput = required<HTMLInputElement>('#file-input');
const fitBtn = required<HTMLButtonElement>('#fit-btn');
const isolateBtn = required<HTMLButtonElement>('#isolate-btn');
const showAllBtn = required<HTMLButtonElement>('#show-all-btn');
const uploadBtn = required<HTMLButtonElement>('#upload-btn');
const uploadInput = required<HTMLInputElement>('#upload-input');
const uploadCancelBtn = required<HTMLButtonElement>('#upload-cancel-btn');
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

// The currently loaded model's real catalog id, if (and only if) it came from the server
// (auto-loaded, or uploaded-and-converted) rather than a purely local file preview -- this
// is what the 3D globe view tab loads when activated. A locally-previewed file (loadFile,
// below) has no catalog id at all, so switching to the globe tab for one has nothing to show.
let currentServerModelId: string | null = null;

async function loadNewestReadyModel(): Promise<void> {
  try {
    const models = (await (await fetch('/api/models')).json()) as ModelSummary[];
    const newestReady = models.find((m) => m.status === 'ready' && m.artifactUrl);
    if (!newestReady?.artifactUrl) {
      appendLog('no ready model in the catalog yet — upload one below.');
      return;
    }
    appendLog(`auto-loading newest ready model "${newestReady.name}"...`);
    const modelInfo = await viewer.loadModel({ id: newestReady.id, name: newestReady.name });
    currentServerModelId = newestReady.id;
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
    currentServerModelId = null; // a local preview has no catalog id -- see its declaration above
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

// --- Upload to server: distinct from the local-preview file-input/drag-drop above, which
// loads bytes directly via viewer.loadModel(ArrayBuffer) and never touches the API. This
// path POSTs to /api/models (single file) or /api/models/batch (multiple files, field
// "files" repeated -- distinct filenames become distinct models per that endpoint's own
// basename-grouping contract), then polls GET /api/models/{id} per created model until the
// Phase 4 worker (or, for an uploaded .glb, the API's own immediate self-publish) finishes
// conversion, and only then loads the real published artifact via
// viewer.loadModel({ id, name }). Multiple models poll concurrently, independently.

interface ModelRecord {
  id: string;
  name: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  artifactUrl: string | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 1500;
const STILL_GOING_LOG_INTERVAL_MS = 15 * 1000;

async function describeError(res: Response): Promise<string> {
  try {
    const problem = (await res.json()) as { detail?: string; title?: string };
    return problem.detail ?? problem.title ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Cancellation is a deliberate user action (the "Cancel all in-flight uploads" button
 * below), not an assumption baked into the poll itself — real conversions (e.g. a large FBX
 * through assimp + Draco) can legitimately take several minutes, so there is no timeout
 * duration that's both safe to give up at and short enough to be a useful default. A worker
 * that's genuinely stuck is better diagnosed by looking at its own logs than by the browser
 * silently abandoning the poll. */
interface PollCancelToken {
  cancelled: boolean;
}

// One entry per in-flight poll, keyed by model id — lets multiple uploads (from a single
// batch selection, or several separate uploads in a row) run concurrently, each independently
// cancellable, and lets "Cancel all in-flight uploads" reach every one of them at once. A
// per-row cancel button (cancelling just one upload) would be a nice follow-up but isn't
// implemented here — this pass only adds an all-or-nothing cancel.
const activePolls = new Map<string, PollCancelToken>();

function updateCancelButtonState(): void {
  uploadCancelBtn.disabled = activePolls.size === 0;
}

async function pollUntilDone(modelId: string, token: PollCancelToken, label: string = modelId): Promise<void> {
  const startedAt = Date.now();
  let lastStatus: string | null = null;
  let lastElapsedLogMs = 0;

  for (;;) {
    if (token.cancelled) {
      appendLog(`upload ${label}: cancelled by user after ${formatElapsed(Date.now() - startedAt)} — the job keeps running on the server.`);
      return;
    }

    const res = await fetch(`/api/models/${modelId}`);
    if (!res.ok) {
      appendLog(`upload ${label}: GET /api/models/${modelId} failed (${await describeError(res)})`);
      return;
    }
    const record = (await res.json()) as ModelRecord;

    if (record.status !== lastStatus) {
      appendLog(`upload ${label}: status -> ${record.status}`);
      lastStatus = record.status;
    }

    if (record.status === 'ready') {
      try {
        const modelInfo = await viewer.loadModel({ id: modelId, name: record.name });
        currentServerModelId = modelId; // see its declaration above loadNewestReadyModel
        appendLog(`upload ${label}: loaded "${modelInfo.name}" — ${modelInfo.objectCount} objects`);
      } catch (err) {
        appendLog(`upload ${label}: status is ready, but loading the artifact failed: ${(err as Error).message}`);
      }
      return;
    }
    if (record.status === 'failed') {
      appendLog(`upload ${label}: FAILED — ${record.error ?? 'unknown error'}`);
      return;
    }

    // Still queued/processing — a periodic heartbeat so it's clear the poll itself hasn't
    // hung, separate from (and possibly on the same tick as) a status-transition log above.
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs - lastElapsedLogMs >= STILL_GOING_LOG_INTERVAL_MS) {
      appendLog(`upload ${label}: still ${record.status}... (${formatElapsed(elapsedMs)} elapsed)`);
      lastElapsedLogMs = elapsedMs;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Registers a fresh cancel token for `modelId` in the shared activePolls map (so "Cancel
 * all in-flight uploads" can reach it and the button's enabled state reflects it), runs the
 * poll to completion, then unregisters — shared by both the single-file and batch paths. */
async function trackedPoll(modelId: string, label: string): Promise<void> {
  const token: PollCancelToken = { cancelled: false };
  activePolls.set(modelId, token);
  updateCancelButtonState();
  try {
    await pollUntilDone(modelId, token, label);
  } finally {
    activePolls.delete(modelId);
    updateCancelButtonState();
  }
}

async function uploadToServer(file: File): Promise<void> {
  appendLog(`uploading ${file.name} to server (POST /api/models)...`);
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/models', { method: 'POST', body: formData });
    if (!res.ok) {
      appendLog(`upload ${file.name} failed: ${await describeError(res)}`);
      return;
    }
    const record = (await res.json()) as ModelRecord;
    appendLog(`upload ${file.name}: created model ${record.id}, status=${record.status}`);
    await trackedPoll(record.id, record.id);
  } catch (err) {
    appendLog(`upload ${file.name} failed: ${(err as Error).message}`);
  }
}

/** Multiple files selected at once -> POST /api/models/batch in a single request (field
 * "files", repeated), matching that endpoint's existing basename-grouping contract exactly
 * (distinct filenames become distinct models — see server/api's own "two distinct
 * basenames..." test). The returned models are polled concurrently and independently; each
 * gets its own log lines prefixed by its name so the concurrent output doesn't read as one
 * confused stream. */
async function uploadBatchToServer(files: File[]): Promise<void> {
  appendLog(`uploading ${files.length} files to server (POST /api/models/batch)...`);
  try {
    const formData = new FormData();
    for (const file of files) formData.append('files', file);
    const res = await fetch('/api/models/batch', { method: 'POST', body: formData });
    if (!res.ok) {
      appendLog(`batch upload failed: ${await describeError(res)}`);
      return;
    }
    const records = (await res.json()) as ModelRecord[];
    appendLog(`batch upload: created ${records.length} model(s) — ${records.map((r) => r.name).join(', ')}`);
    await Promise.all(records.map((record) => trackedPoll(record.id, record.name)));
  } catch (err) {
    appendLog(`batch upload failed: ${(err as Error).message}`);
  }
}

uploadBtn.addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', () => {
  const files = uploadInput.files ? [...uploadInput.files] : [];
  if (files.length === 1) {
    void uploadToServer(files[0]!);
  } else if (files.length > 1) {
    void uploadBatchToServer(files);
  }
  uploadInput.value = ''; // allow re-selecting the same file name(s) in a row
});
uploadCancelBtn.addEventListener('click', () => {
  for (const token of activePolls.values()) token.cancelled = true;
});

// --- 3D Globe view tab: a sibling rendering surface (own canvas, own Cesium.Viewer/WebGL
// context), not a plugin -- see CLAUDE.md's "Rendering surfaces" note. Complementary to the
// 2D Map/Georeference view above, not a replacement: both read the same georef data via the
// same REST API, just rendered differently. Constructed lazily (only on first activation) so
// a Cesium.Viewer/WebGL context is never created unless the tab is actually used.
let globeView: GlobeView | null = null;

function ensureGlobeView(): GlobeView {
  globeView ??= new GlobeView(globeContainer, {
    providerConfig: { ionAccessToken: import.meta.env.VITE_CESIUM_ION_TOKEN },
  });
  return globeView;
}

function activate2dTab(): void {
  tab2dBtn.setAttribute('aria-pressed', 'true');
  tabGlobeBtn.setAttribute('aria-pressed', 'false');
  viewerContainer.style.display = '';
  globeContainer.style.display = 'none';
}

async function activateGlobeTab(): Promise<void> {
  tab2dBtn.setAttribute('aria-pressed', 'false');
  tabGlobeBtn.setAttribute('aria-pressed', 'true');
  viewerContainer.style.display = 'none';
  globeContainer.style.display = '';

  if (!currentServerModelId) {
    appendLog(
      '3D globe view: no server-backed model is currently loaded (a local-preview file has no ' +
        'catalog id to look up) -- upload one, or wait for the auto-loaded catalog model, then switch tabs again.',
    );
    return;
  }

  try {
    const result = await ensureGlobeView().loadModelById(currentServerModelId);
    if (result.kind === 'placed') {
      appendLog(`3D globe view: placed — ${result.statusLabel}`);
    } else if (result.kind === 'no-georef') {
      appendLog('3D globe view: this model has no georeference set yet -- set one in the 2D Map/Georeference view first.');
    } else {
      appendLog(`3D globe view: model is not ready yet (status: ${result.status}).`);
    }
  } catch (err) {
    appendLog(`3D globe view failed to load the model: ${(err as Error).message}`);
  }
}

tab2dBtn.addEventListener('click', activate2dTab);
tabGlobeBtn.addEventListener('click', () => void activateGlobeTab());
