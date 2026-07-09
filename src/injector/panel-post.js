import { cacheEpochPayload, cacheRuntimePayload, getPanelSyncPayload, getPanelSyncSummary } from './panel-sync-cache.js';

const CHANNEL = 'StateScopeExtension';
const MIN_EPOCH_RELAY_MS = 250;
let lastEpochRelayAt = 0;
let pendingEpochPayload = null;
let epochFlushTimer = null;

function isRelayBroken() {
  try {
    return (
      window.__StateScopeRelayBroken__ === true ||
      window.__StateScope__?.extensionRelayBroken === true
    );
  } catch {
    return true;
  }
}

export function postToExtension(type, payload) {
  if (isRelayBroken()) {
    return false;
  }
  try {
    window.postMessage(
      {
        channel: CHANNEL,
        type,
        payload
      },
      '*'
    );
    return true;
  } catch {
    return false;
  }
}

function flushPendingEpoch() {
  epochFlushTimer = null;
  if (!pendingEpochPayload || isRelayBroken()) {
    pendingEpochPayload = null;
    return;
  }
  const payload = pendingEpochPayload;
  pendingEpochPayload = null;
  lastEpochRelayAt = Date.now();
  postToExtension('SS_EPOCH', payload);
}

export function publishEpochToPanel(epochPayload) {
  cacheEpochPayload(epochPayload);
  if (isRelayBroken()) {
    return;
  }

  const now = Date.now();
  if (now - lastEpochRelayAt >= MIN_EPOCH_RELAY_MS) {
    lastEpochRelayAt = now;
    postToExtension('SS_EPOCH', epochPayload);
    return;
  }

  pendingEpochPayload = epochPayload;
  if (!epochFlushTimer) {
    const delay = Math.max(0, MIN_EPOCH_RELAY_MS - (now - lastEpochRelayAt));
    epochFlushTimer = setTimeout(flushPendingEpoch, delay);
  }
}

export function publishRuntimeToPanel(runtimePayload) {
  cacheRuntimePayload(runtimePayload);
  postToExtension('SS_RUNTIME', runtimePayload);
}

export function republishCachedPanelState() {
  const api = window.__StateScope__;
  if (api) {
    api.extensionRelayBroken = false;
  }
  try {
    window.__StateScopeRelayBroken__ = false;
  } catch {
    // ignore
  }

  const { runtime, epochs } = getPanelSyncPayload();

  if (runtime) {
    postToExtension('SS_RUNTIME', runtime);
  }

  for (const epochPayload of [...epochs].reverse()) {
    postToExtension('SS_EPOCH', epochPayload);
  }

  return {
    runtime: !!runtime,
    epochCount: epochs.length
  };
}

export { getPanelSyncPayload, getPanelSyncSummary };
