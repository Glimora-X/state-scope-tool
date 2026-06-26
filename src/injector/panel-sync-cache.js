let runtimePayloadCache = null;
const epochPayloadCache = [];
const MAX_CACHED_EPOCHS = 20;

export function cacheRuntimePayload(payload) {
  runtimePayloadCache = payload;
}

export function cacheEpochPayload(payload) {
  if (!payload?.id) {
    return;
  }
  const next = [payload, ...epochPayloadCache.filter((item) => item.id !== payload.id)];
  epochPayloadCache.length = 0;
  epochPayloadCache.push(...next.slice(0, MAX_CACHED_EPOCHS));
}

export function getPanelSyncPayload() {
  return {
    runtime: runtimePayloadCache,
    epochs: [...epochPayloadCache]
  };
}
