import { cacheEpochPayload, cacheRuntimePayload, getPanelSyncPayload, getPanelSyncSummary } from './panel-sync-cache.js';
import { slimEpochForScenarioSync } from '../shared/slim-epoch.js';

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

/** 中继到扩展：瘦身，否则大 diffs 会撑爆 chrome.runtime.sendMessage */
function toRelayEpoch(epochPayload) {
  const slim = slimEpochForScenarioSync(epochPayload);
  if (!slim) {
    return null;
  }
  const logicDiffs = (epochPayload.diffs || [])
    .filter((row) => row?.severity === 'logic-mismatch')
    .slice(0, 40)
    .map((row) => ({
      path: row.path,
      severity: row.severity,
      stateType: row.stateType,
      old: row.old,
      new: row.new,
      oldLabel: row.oldLabel,
      newLabel: row.newLabel
    }));
  return { ...slim, diffs: logicDiffs };
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
      window.location.origin
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
  const relay = toRelayEpoch(payload);
  if (relay) {
    postToExtension('SS_EPOCH', relay);
  }
}

export function publishEpochToPanel(epochPayload) {
  cacheEpochPayload(epochPayload);
  if (isRelayBroken()) {
    return;
  }

  const now = Date.now();
  if (now - lastEpochRelayAt >= MIN_EPOCH_RELAY_MS) {
    lastEpochRelayAt = now;
    const relay = toRelayEpoch(epochPayload);
    if (relay) {
      postToExtension('SS_EPOCH', relay);
    }
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
    const relay = toRelayEpoch(epochPayload);
    if (relay) {
      postToExtension('SS_EPOCH', relay);
    }
  }

  return {
    runtime: !!runtime,
    epochCount: epochs.length
  };
}

export { getPanelSyncPayload, getPanelSyncSummary };
