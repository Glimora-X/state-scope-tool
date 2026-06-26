/** Background 只存摘要，避免 chrome.runtime.sendMessage 超大 payload 导致 GET_STATE 失败 */
export function slimEpochForStorage(epoch) {
  if (!epoch || epoch.id == null) {
    return epoch;
  }

  return {
    id: epoch.id,
    trigger: epoch.trigger,
    phase: epoch.phase,
    startedAt: epoch.startedAt,
    timeLabel: epoch.timeLabel,
    meta: epoch.meta,
    hasNewChain: epoch.hasNewChain,
    allowlistMeta: epoch.allowlistMeta,
    allowlistFieldResults: epoch.allowlistFieldResults,
    diffSummary: epoch.diffSummary,
    scenarioTag: epoch.scenarioTag,
    counts: epoch.counts,
    health: epoch.health,
    anomalies: epoch.anomalies,
    scope: epoch.scope,
    scopeLine: epoch.scopeLine,
    scopeFlow: epoch.scopeFlow,
    groupTitle: epoch.groupTitle,
    detailPathHint: epoch.detailPathHint,
    changedGroups: epoch.changedGroups,
    diffs: epoch.diffs,
    diffGroups: epoch.diffGroups,
    showMain: epoch.showMain,
    showDetail: epoch.showDetail
  };
}

export function slimEpochList(epochs) {
  if (!Array.isArray(epochs)) {
    return [];
  }
  return epochs.map(slimEpochForStorage).filter((item) => item?.id != null);
}
