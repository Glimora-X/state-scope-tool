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

function enrichDiffRow(row, hasNewChain) {
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
      resultLabel: '待接入'
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

export function buildPanelEpochPayload(epoch, meta, allowlistConfig) {
  const hasNewChain = Object.keys(epoch.newSnap || {}).length > 0;
  const allowlist = allowlistConfig ? buildAllowlistPathSet(allowlistConfig) : undefined;
  const scopeLine = formatScopeLine(epoch.scope);
  const groupTitle = formatGroupTitle(epoch.scope, epoch.changedSample, epoch.finalSnap);
  const detailPathHint = formatDetailPathHint(epoch.finalSnap, epoch.changedSample);

  const changedSetSnap = buildChangedSetFinalSnap(epoch.finalSnap, epoch.changedSample);
  const mainSnap = pickMainKeys(epoch.finalSnap);
  const detailSnap = pickDetailKeys(epoch.finalSnap, epoch.changedSample);

  const rawDiffs = diffSnapshots(epoch.oldSnap, epoch.newSnap, allowlist);
  const diffs = rawDiffs.map((row) => enrichDiffRow(row, hasNewChain));
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
  const meta = {
    boName:
      runtimeContext.boName ||
      runtimeContext.bizApplication?.boName ||
      runtimeContext.presenter?.voucherBoName ||
      '',
    profile: runtimeContext.profile || 'unknown',
    route: typeof location !== 'undefined' ? location.pathname : ''
  };

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
      boName: meta.boName
    },
    updatedAt: Date.now()
  };
}
