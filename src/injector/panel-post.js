import { cacheEpochPayload, cacheRuntimePayload, getPanelSyncPayload } from './panel-sync-cache.js';

const CHANNEL = 'StateScopeExtension';

export function postToExtension(type, payload) {
  try {
    window.postMessage(
      {
        channel: CHANNEL,
        type,
        payload
      },
      '*'
    );
  } catch {
    // ignore
  }
}

export function publishEpochToPanel(epochPayload) {
  cacheEpochPayload(epochPayload);
  postToExtension('SS_EPOCH', epochPayload);
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

export { getPanelSyncPayload };
