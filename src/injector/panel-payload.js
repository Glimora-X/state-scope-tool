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
import { getScenarioTag } from './scenario-context.js';
import { getRuntimeMeta } from './detect.js';
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

function enrichDiffRow(row, hasNewChain, profile) {
  const parsed = row.path.split('.');
  let displayName = parsed[parsed.length - 2] || row.path;
  let gridHint = null;
  if (parsed.length >= 4 && parsed[0] !== 'main') {
    displayName = parsed[2];
    gridHint = `grid#${parsed[1]}`;
  }

  if (!hasNewChain) {
    const pendingLabel = profile === 'lowcode' ? 'shadow 未接入' : '待接入';
    return {
      ...row,
      displayName,
      gridHint,
      oldLabel: formatVal(row.old),
      newLabel: '—',
      new: undefined,
      severity: 'pending',
      resultLabel: pendingLabel
    };
  }

  return {
    ...row,
    displayName,
    gridHint,
    oldLabel: formatVal(row.old),
    newLabel: formatVal(row.new),
    resultLabel: row.severity
  };
}

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

  const oldSnapForDiff = resolveOldSnapForDiff(epoch, profile);
  const newSnapForDiff = resolveNewSnapForDiff(epoch, profile);
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
    scenarioTag: getScenarioTag() || ''
  };
}

export function buildRuntimePayload(runtimeContext) {
  const meta = getRuntimeMeta(runtimeContext);

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
    updatedAt: Date.now()
  };
}
