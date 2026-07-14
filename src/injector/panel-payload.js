import {
  buildAllowlistFieldResults,
  buildAllowlistMeta,
  buildAllowlistPathSet
} from './allowlist-config.js';
import { diffSnapshots } from './diff.js';
import { formatGroupTitle, formatScopeLine, formatDetailPathHint } from './legacy-diagnostics.js';
import {
  buildAnomalies,
  buildEpochHealth,
  buildImpactStats,
  buildScopeFlow,
  formatEpochTime,
  groupChangedByBusiness
} from './panel-view-model.js';
import { getScenarioTag, getScenarioCatalogPack } from './scenario-context.js';
import { getRuntimeMeta } from './detect.js';
import { getHookLiveness } from './hook-registry.js';
import {
  buildChangedSetFinalSnap,
  buildDetailGrids,
  countDisabledStats,
  formatVal,
  groupDiffRows,
  hasDetailKeys,
  pickDetailKeys,
  pickMainKeys,
  snapToRows,
  summarizeDiffs
} from './snap-view.js';

import { severityZh, SHADOW_STORE_MISSING, NEW_ONLY_HINT } from '../shared/zh-labels.js';
import { alignLowcodeDetailIndexUuidKeys } from './lowcode-sample.js';

function enrichDiffRow(row, hasNewChain, profile) {
  const parsed = row.path.split('.');
  let displayName = parsed[parsed.length - 2] || row.path;
  let gridHint = null;
  if (parsed.length >= 4 && parsed[0] !== 'main') {
    displayName = parsed[2];
    gridHint = `grid#${parsed[1]}`;
  }

  if (!hasNewChain) {
    return {
      ...row,
      displayName,
      gridHint,
      oldLabel: formatVal(row.old),
      newLabel: '—',
      new: undefined,
      severity: 'pending',
      resultLabel: SHADOW_STORE_MISSING.short
    };
  }

  const severity = row.severity;
  return {
    ...row,
    displayName,
    gridHint,
    oldLabel: formatVal(row.old),
    newLabel: formatVal(row.new),
    resultLabel: severityZh(severity),
    hint: severity === 'new-only' && profile === 'lowcode' ? NEW_ONLY_HINT.subline : undefined
  };
}

/**
 * 解析 Diff 旧侧（old-side）快照。
 *
 * - lowcode：返回 finalSnap（即可见态），Diff 旧侧 = 用户所见终态
 * - traditional：返回 oldSnap 或 finalSnap（取决于 phase 和 scope）
 */
function resolveOldSnapForDiff(epoch, profile) {
  const oldSnap = epoch.oldSnap || {};
  const finalSnap = epoch.finalSnap || {};

  if (profile === 'lowcode') {
    if (Object.keys(finalSnap).length > 0) {
      return finalSnap;
    }
    return oldSnap;
  }

  if (epoch.phase === 'init-full' && Object.keys(finalSnap).length > 0) {
    return finalSnap;
  }
  if ((epoch.scope?.mainRecalcCount || 0) > 0 && Object.keys(finalSnap).length > Object.keys(oldSnap).length) {
    return finalSnap;
  }
  return oldSnap;
}

/**
 * 解析 Diff 新侧（new-side）快照。
 *
 * - lowcode：返回 shadowSnap（影子态），Diff 新侧 = shadowStore 终态
 * - traditional：返回 newSnap（升级后链路终态）
 */
function resolveNewSnapForDiff(epoch, profile) {
  const newSnap = epoch.newSnap || {};
  const shadowSnap = epoch.shadowSnap || {};
  if (profile === 'lowcode') {
    return { ...newSnap, ...shadowSnap };
  }
  return newSnap;
}

function resolveHasNewChain(epoch, profile) {
  const newSnap = epoch.newSnap || {};
  const shadowSnap = epoch.shadowSnap || {};
  if (profile === 'lowcode') {
    return Object.keys(shadowSnap).length > 0 || Object.keys(newSnap).length > 0;
  }
  return Object.keys(newSnap).length > 0;
}

export function buildPanelEpochPayload(epoch, meta, allowlistConfig) {
  const profile = meta?.profile || 'unknown';
  const hasNewChain = resolveHasNewChain(epoch, profile);
  const allowlist = allowlistConfig ? buildAllowlistPathSet(allowlistConfig) : undefined;
  const scopeLine = formatScopeLine(epoch.scope);
  const groupTitle = formatGroupTitle(epoch.scope, epoch.changedSample, epoch.finalSnap);
  const detailPathHint = formatDetailPathHint(epoch.finalSnap, epoch.changedSample);

  const changedSetSnap = buildChangedSetFinalSnap(epoch.finalSnap, epoch.changedSample);
  const mainSnap = pickMainKeys(epoch.finalSnap);
  const detailSnap = pickDetailKeys(epoch.finalSnap, epoch.changedSample);

  const oldSnapForDiffRaw = resolveOldSnapForDiff(epoch, profile);
  const newSnapForDiffRaw = resolveNewSnapForDiff(epoch, profile);
  const aligned =
    profile === 'lowcode' ?
      alignLowcodeDetailIndexUuidKeys(oldSnapForDiffRaw, newSnapForDiffRaw)
    : { oldSnap: oldSnapForDiffRaw, newSnap: newSnapForDiffRaw };
  const oldSnapForDiff = aligned.oldSnap;
  const newSnapForDiff = aligned.newSnap;
  const rawDiffs = diffSnapshots(oldSnapForDiff, newSnapForDiff, allowlist);
  const diffs = rawDiffs.map((row) => enrichDiffRow(row, hasNewChain, profile));
  const diffSummary = summarizeDiffs(diffs);
  const diffGroups = groupDiffRows(diffs);
  const changedRows = snapToRows(changedSetSnap, { changedSample: epoch.changedSample, highlightChanged: true });

  return {
    id: epoch.id,
    trigger: epoch.trigger,
    phase: epoch.phase,
    startedAt: epoch.startedAt || Date.now(),
    timeLabel: formatEpochTime(epoch.startedAt || Date.now()),
    scope: epoch.scope,
    scopeLine,
    scopeFlow: buildScopeFlow(epoch.scope, {
      changedSample: Object.keys(epoch.changedSample || {}).length,
      finalSnap: Object.keys(epoch.finalSnap || {}).length
    }),
    groupTitle,
    detailPathHint,
    meta: meta || {},
    hasNewChain,
    health: buildEpochHealth({
      diffSummary,
      counts: {
        changedSample: Object.keys(epoch.changedSample || {}).length,
        finalSnap: Object.keys(epoch.finalSnap || {}).length
      },
      hasNewChain
    }),
    impact: buildImpactStats({
      sections: {
        main: { count: Object.keys(mainSnap).length },
        detail: { count: Object.keys(detailSnap).length }
      },
      counts: {
        changedSample: Object.keys(epoch.changedSample || {}).length,
        finalSnap: Object.keys(epoch.finalSnap || {}).length
      },
      diffSummary
    }),
    anomalies: buildAnomalies({ diffs, diffSummary, hasNewChain }),
    changedGroups: groupChangedByBusiness(changedRows),
    counts: {
      changedSample: Object.keys(epoch.changedSample || {}).length,
      finalSnap: Object.keys(epoch.finalSnap || {}).length
    },
    diffSummary,
    diffs,
    diffGroups,
    sections: {
      changedSet: {
        count: Object.keys(changedSetSnap).length,
        stats: countDisabledStats(changedSetSnap),
        rows: changedRows
      },
      main: {
        count: Object.keys(mainSnap).length,
        stats: countDisabledStats(mainSnap),
        rows: snapToRows(mainSnap, { changedSample: epoch.changedSample, highlightChanged: true })
      },
      detail: {
        count: Object.keys(detailSnap).length,
        grids: buildDetailGrids(epoch.finalSnap, epoch.changedSample, { allColumns: false }),
        gridsAll: buildDetailGrids(epoch.finalSnap, epoch.changedSample, { allColumns: true })
      }
    },
    showMain: (epoch.scope?.mainRecalcCount || 0) > 0 || Object.keys(mainSnap).length > 0,
    showDetail:
      hasDetailKeys(epoch.finalSnap, epoch.changedSample) || (epoch.scope?.detailRowsInChangedSet || 0) > 0,
    allowlistMeta: buildAllowlistMeta(allowlistConfig),
    allowlistFieldResults: buildAllowlistFieldResults(allowlistConfig, rawDiffs, hasNewChain),
    scenarioTag: getScenarioTag() || '',
    isBootstrap: !!epoch.isBootstrap,
    shadowCaptured: epoch.shadowCaptured !== undefined ? !!epoch.shadowCaptured : hasNewChain,
    bootstrapQuality: epoch.bootstrapQuality || undefined,
    visibleSnap: profile === 'lowcode' ? oldSnapForDiff : undefined,
    shadowSnap: profile === 'lowcode' ? newSnapForDiff : undefined,
    diffAxis: profile === 'lowcode'
      ? { old: 'visibleSnap (用户所见)', new: 'shadowSnap (影子终态)' }
      : { old: 'oldSnap (操作前)', new: 'newSnap (操作后)' }
  };
}

export function buildRuntimePayload(runtimeContext) {
  const meta = getRuntimeMeta(runtimeContext);
  const catalogPack = meta.boName ? getScenarioCatalogPack(meta.boName) : null;

  return {
    meta,
    diagnostics: {
      bizDebug: typeof localStorage !== 'undefined' && localStorage.getItem('bizDebug') === 'true',
      windowBizApplication: !!window.bizApplication,
      stateManager: !!runtimeContext.bizApplication?.stateManager,
      presenter: !!runtimeContext.presenter,
      uiStateController: !!runtimeContext.uiStateController,
      formController: !!runtimeContext.formController,
      lowcodeViewModel: !!runtimeContext.viewModel,
      boName: meta.boName,
      profile: meta.profile,
      profileDetection: meta.profileDetection || null
    },
    hookLiveness: getHookLiveness(),
    scenarioCatalogPack: catalogPack || undefined,
    updatedAt: Date.now()
  };
}
