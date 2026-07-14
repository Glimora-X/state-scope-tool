/** Background 只存摘要，禁止夹带 diffs 等大字段 —— 否则 SS_BULK_SYNC / SS_GET_STATE 会静默失败，场景永远不更新 */

function normalizeEpochId(id) {
  if (id == null) {
    return id;
  }
  return typeof id === 'number' ? id : Number(id) || id;
}

export function slimEpochForStorage(epoch) {
  if (!epoch || epoch.id == null) {
    return epoch;
  }

  return {
    id: normalizeEpochId(epoch.id),
    trigger: epoch.trigger,
    phase: epoch.phase,
    startedAt: epoch.startedAt,
    timeLabel: epoch.timeLabel,
    meta: epoch.meta,
    hasNewChain: !!epoch.hasNewChain,
    allowlistMeta: epoch.allowlistMeta || null,
    allowlistFieldResults: Array.isArray(epoch.allowlistFieldResults) ? epoch.allowlistFieldResults : [],
    diffSummary: epoch.diffSummary || null,
    scenarioTag: epoch.scenarioTag || '',
    counts: epoch.counts || null,
    health: epoch.health || null,
    anomalies: Array.isArray(epoch.anomalies) ? epoch.anomalies.slice(0, 20) : [],
    scope: epoch.scope || null,
    scopeLine: epoch.scopeLine || '',
    scopeFlow: epoch.scopeFlow || null,
    groupTitle: epoch.groupTitle || '',
    detailPathHint: epoch.detailPathHint || ''
  };
}

/** Panel → SW 批量同步：比 storage 更瘦，只保留场景/切流累计必需字段 */
export function slimEpochForScenarioSync(epoch) {
  if (!epoch || epoch.id == null) {
    return null;
  }
  return {
    id: normalizeEpochId(epoch.id),
    trigger: epoch.trigger || '',
    phase: epoch.phase || '',
    startedAt: epoch.startedAt || 0,
    timeLabel: epoch.timeLabel || '',
    hasNewChain: !!epoch.hasNewChain,
    allowlistMeta: epoch.allowlistMeta || null,
    allowlistFieldResults: Array.isArray(epoch.allowlistFieldResults) ? epoch.allowlistFieldResults : [],
    diffSummary: epoch.diffSummary || null,
    scenarioTag: epoch.scenarioTag || '',
    counts: epoch.counts || null
  };
}

export function slimEpochList(epochs) {
  if (!Array.isArray(epochs)) {
    return [];
  }
  return epochs.map(slimEpochForStorage).filter((item) => item?.id != null);
}

export { normalizeEpochId };
