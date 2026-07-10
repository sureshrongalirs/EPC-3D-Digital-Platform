import { GlobeView, type PickedNodeInfo } from '@plantscope/globe-view';

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

const globeContainer = required<HTMLDivElement>('#globe-container');
const propertiesPanel = required<HTMLDivElement>('#properties-panel');
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

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function renderProperties(picked: PickedNodeInfo): void {
  if (!picked.componentProps) {
    propertiesPanel.textContent = `${picked.nodeName}: no engineering properties found for this node.`;
    return;
  }
  const rows = Object.entries(picked.componentProps)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`)
    .join('');
  propertiesPanel.innerHTML = `<strong>${escapeHtml(picked.nodeName)}</strong><table>${rows}</table>`;
}

// The 3D globe is the ONLY view (see CLAUDE.md's "Rendering surfaces" note) -- constructed
// immediately, in a container that's visible with real pixel dimensions from the very first
// render (not lazily, not inside a hidden div; that was a real bug in an earlier version of
// this app). No model is loaded yet at this point -- the globe itself (Earth) is visible
// right away regardless.
let lastPickedNodeName: string | null = null;

const globeView = new GlobeView(globeContainer, {
  providerConfig: { ionAccessToken: import.meta.env.VITE_CESIUM_ION_TOKEN },
  onStatus: appendLog,
  onPick: (picked) => {
    lastPickedNodeName = picked.nodeName;
    renderProperties(picked);
    appendLog(`pick -> ${picked.nodeName}`);
  },
});

async function loadNewestReadyModel(): Promise<void> {
  try {
    const models = (await (await fetch('/api/models')).json()) as ModelSummary[];
    const newestReady = models.find((m) => m.status === 'ready' && m.artifactUrl);
    if (!newestReady) {
      appendLog('no ready model in the catalog yet -- upload one below.');
      return;
    }
    appendLog(`auto-loading newest ready model "${newestReady.name}"...`);
    const result = await globeView.loadModelById(newestReady.id);
    if (result.kind === 'placed') appendLog(`placed "${newestReady.name}": ${result.statusLabel}`);
  } catch (err) {
    appendLog(`failed to reach the API: ${(err as Error).message}`);
  }
}
void loadNewestReadyModel();

async function loadFile(file: File): Promise<void> {
  appendLog(`loading ${file.name} (local preview)...`);
  try {
    await globeView.loadLocalFile(file);
  } catch (err) {
    appendLog(`failed to load ${file.name}: ${(err as Error).message}`);
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});

// Drag-drop is attached to the globe container itself (not a covering overlay) so it never
// blocks pointer events needed for picking.
globeContainer.addEventListener('dragover', (event) => {
  event.preventDefault();
});
globeContainer.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});
// Prevent the browser from navigating to the dropped file if it misses the container.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

fitBtn.addEventListener('click', () => globeView.fitToModel());
isolateBtn.addEventListener('click', () => {
  if (lastPickedNodeName) globeView.isolate(lastPickedNodeName);
});
showAllBtn.addEventListener('click', () => globeView.showAll());

// --- Upload to server: distinct from the local-preview file-input/drag-drop above, which
// loads bytes directly via globeView.loadLocalFile(File) and never touches the API. Always
// POSTs to /api/models/batch (field "files", repeated), even for a single file -- see
// uploadFilesToServer's doc comment for why always using the batch endpoint (rather than
// branching to a single-file POST /api/models) matters for correctly grouping an FBX with
// an LLH file uploaded alongside it. Then polls GET /api/models/{id} per created model until
// the Phase 4 worker (or, for an uploaded .glb, the API's own immediate self-publish)
// finishes conversion, and only then loads the real published artifact via
// globeView.loadModelById(id), which reads back whatever georef the worker already wrote
// from an LLH file in that same batch -- no manual "save georeference" step needed here.
// Multiple models poll concurrently, independently.

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
 * below), not an assumption baked into the poll itself -- real conversions (e.g. a large FBX
 * through assimp + Draco) can legitimately take several minutes, so there is no timeout
 * duration that's both safe to give up at and short enough to be a useful default. A worker
 * that's genuinely stuck is better diagnosed by looking at its own logs than by the browser
 * silently abandoning the poll. */
interface PollCancelToken {
  cancelled: boolean;
}

// One entry per in-flight poll, keyed by model id -- lets multiple uploads (from a single
// batch selection, or several separate uploads in a row) run concurrently, each independently
// cancellable, and lets "Cancel all in-flight uploads" reach every one of them at once. A
// per-row cancel button (cancelling just one upload) would be a nice follow-up but isn't
// implemented here -- this pass only adds an all-or-nothing cancel.
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
      appendLog(`upload ${label}: cancelled by user after ${formatElapsed(Date.now() - startedAt)} -- the job keeps running on the server.`);
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
        const result = await globeView.loadModelById(modelId);
        if (result.kind === 'placed') appendLog(`upload ${label}: placed -- ${result.statusLabel}`);
      } catch (err) {
        appendLog(`upload ${label}: status is ready, but loading the artifact failed: ${(err as Error).message}`);
      }
      return;
    }
    if (record.status === 'failed') {
      appendLog(`upload ${label}: FAILED -- ${record.error ?? 'unknown error'}`);
      return;
    }

    // Still queued/processing -- a periodic heartbeat so it's clear the poll itself hasn't
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
 * poll to completion, then unregisters -- shared by both the single-file and batch paths. */
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

/** Always POSTs to /api/models/batch (field "files", repeated) -- even for a single file --
 * rather than branching to the single-file POST /api/models for that case. /api/models/batch
 * groups by basename (server/api's own "two distinct basenames..." test), so an FBX
 * uploaded alongside an LLH file with the same basename (e.g. "plant.fbx" + "plant.llh")
 * is grouped into one model regardless of selection order; sending them as two separate
 * single-file uploads instead would create two unrelated models and the LLH would never
 * reach the worker as that FBX's georef source. The worker already parses an LLH file and
 * writes its georef automatically (Phase 4) -- by the time a model's status is 'ready',
 * loadModelById's GET .../georef already has it, with no extra "save georeference" step
 * needed here. The returned models are polled concurrently and independently; each gets its
 * own log lines prefixed by its name so concurrent output doesn't read as one confused
 * stream. */
async function uploadFilesToServer(files: File[]): Promise<void> {
  appendLog(`uploading ${files.length} file(s) to server (POST /api/models/batch)...`);
  try {
    const formData = new FormData();
    for (const file of files) formData.append('files', file);
    const res = await fetch('/api/models/batch', { method: 'POST', body: formData });
    if (!res.ok) {
      appendLog(`upload failed: ${await describeError(res)}`);
      return;
    }
    const records = (await res.json()) as ModelRecord[];
    appendLog(`upload: created ${records.length} model(s) -- ${records.map((r) => r.name).join(', ')}`);
    await Promise.all(records.map((record) => trackedPoll(record.id, record.name)));
  } catch (err) {
    appendLog(`upload failed: ${(err as Error).message}`);
  }
}

uploadBtn.addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', () => {
  const files = uploadInput.files ? [...uploadInput.files] : [];
  if (files.length > 0) void uploadFilesToServer(files);
  uploadInput.value = ''; // allow re-selecting the same file name(s) in a row
});
uploadCancelBtn.addEventListener('click', () => {
  for (const token of activePolls.values()) token.cancelled = true;
});
