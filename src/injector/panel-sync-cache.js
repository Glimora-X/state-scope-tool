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

/** Panel 轮询用：不含 sections/diffs 等大对象 */
export function getPanelSyncSummary() {
  return {
    runtime: runtimePayloadCache,
    epochCount: epochPayloadCache.length,
    latestEpochId: epochPayloadCache[0]?.id ?? null,
    latestStartedAt: epochPayloadCache[0]?.startedAt ?? null,
    epochSummaries: epochPayloadCache.map((item) => ({
      id: item.id,
      trigger: item.trigger,
      phase: item.phase,
      startedAt: item.startedAt,
      timeLabel: item.timeLabel,
      counts: item.counts,
      diffSummary: item.diffSummary,
      hasNewChain: item.hasNewChain,
      meta: item.meta
    }))
  };
}
