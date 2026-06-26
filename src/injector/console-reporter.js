import { buildAllowlistPathSet } from './allowlist-config.js';
import { diffSnapshots, SEVERITY } from './diff.js';
import { isVerboseMode } from './path-filter.js';
import { formatGroupTitle, formatScopeLine, formatDetailPathHint } from './legacy-diagnostics.js';
import { isDebugMode, storeEpoch } from './debug-store.js';
import { scopeLog, scopeLogBlock } from './safe-log.js';
import { buildPanelEpochPayload } from './panel-payload.js';
import { publishEpochToPanel } from './panel-post.js';
import {
  buildChangedSetFinalSnap,
  formatValLong,
  hasDetailKeys,
  pickDetailKeys,
  pickMainKeys
} from './snap-view.js';

let epochCounter = 0;
const MAX_DETAIL_LINES = 12;
const MAX_RESULT_LINES = 20;

export function createEpochManager(onFinalize) {
  let currentEpoch = null;

  function beginEpoch(trigger, phase = 'incremental') {
    epochCounter += 1;
    currentEpoch = {
      id: epochCounter,
      trigger,
      phase,
      startedAt: Date.now(),
      scope: null,
      changedSample: {},
      finalSnap: {},
      oldSnap: {},
      newSnap: {}
    };
    return currentEpoch.id;
  }

  function setScope(scope) {
    if (currentEpoch) {
      currentEpoch.scope = scope;
    }
  }

  function recordChangedSample(entries) {
    if (!currentEpoch || !entries) {
      return;
    }
    Object.assign(currentEpoch.changedSample, entries);
    Object.assign(currentEpoch.oldSnap, entries);
  }

  function recordFinal(entries) {
    if (!currentEpoch || !entries) {
      return;
    }
    Object.assign(currentEpoch.finalSnap, entries);
  }

  function recordOld(entries) {
    recordChangedSample(entries);
  }

  function recordNew(entries) {
    if (!currentEpoch || !entries) {
      return;
    }
    Object.assign(currentEpoch.newSnap, entries);
  }

  function commitEpoch() {
    if (!currentEpoch) {
      return;
    }

    const epoch = currentEpoch;
    currentEpoch = null;

    const hasOld = Object.keys(epoch.oldSnap).length > 0 || Object.keys(epoch.finalSnap).length > 0;
    const hasNew = Object.keys(epoch.newSnap).length > 0;
    if (!hasOld && !hasNew) {
      return;
    }

    onFinalize(epoch);
  }

  return {
    beginEpoch,
    setScope,
    recordChangedSample,
    recordFinal,
    recordOld,
    recordNew,
    commitEpoch,
    finalizeEpoch: commitEpoch
  };
}

function buildResultLines(snap, maxLines) {
  const keys = Object.keys(snap || {});
  const limit = isVerboseMode() ? keys.length : Math.min(keys.length, maxLines);
  const lines = [];

  for (let i = 0; i < limit; i += 1) {
    const key = keys[i];
      lines.push(`${key} = ${formatValLong(snap[key])}`);
  }
  if (keys.length > limit) {
    lines.push(`… +${keys.length - limit} more (stateScopeVerbose=true)`);
  }

  return { keys, lines };
}

function printSnapSection(label, snap) {
  const { keys, lines } = buildResultLines(snap, MAX_RESULT_LINES);
  if (!keys.length) {
    return 0;
  }
  scopeLogBlock(`${label} (${keys.length} 条)`, lines);
  return keys.length;
}

export function reportEpochToConsole(epoch, meta, allowlistConfig) {
  storeEpoch(epoch, meta);
  publishEpochToPanel(buildPanelEpochPayload(epoch, meta, allowlistConfig));

  const allowlist = allowlistConfig ? buildAllowlistPathSet(allowlistConfig) : undefined;
  const diffs = diffSnapshots(epoch.oldSnap, epoch.newSnap, allowlist);
  const mismatches = diffs.filter((item) => item.severity !== SEVERITY.OK);
  const logicMismatches = mismatches.filter((item) => item.severity === SEVERITY.LOGIC_MISMATCH);
  const hasNewChain = Object.keys(epoch.newSnap).length > 0;
  const scopeLine = formatScopeLine(epoch.scope);
  const groupTitle = formatGroupTitle(epoch.scope, epoch.changedSample, epoch.finalSnap);

  const header = `Epoch #${epoch.id} | ${meta.boName || '(unknown bo)'} | ${meta.profile} | ${epoch.phase} | trigger=${epoch.trigger}`;

  if (!hasNewChain && (Object.keys(epoch.finalSnap).length > 0 || epoch.scope)) {
    scopeLog(`${header} | ${groupTitle}`);

    if (scopeLine) {
      scopeLog(`scope: ${scopeLine}`);
    }

    const detailPathHint = formatDetailPathHint(epoch.finalSnap, epoch.changedSample);
    if (detailPathHint) {
      scopeLog(`明细路径: ${detailPathHint}`);
    }

    const changedSetSnap = buildChangedSetFinalSnap(epoch.finalSnap, epoch.changedSample);
    const changedSetCount = printSnapSection('变更集字段终态', changedSetSnap);

    if (!changedSetCount && Object.keys(epoch.changedSample).length > 0) {
      scopeLog(
        `变更集字段终态为空: changedSample=${Object.keys(epoch.changedSample).length} 条，` +
          '请运行 __StateScope__.diagnoseLastEpoch() 查看 key 格式'
      );
    }

    if ((epoch.scope?.mainRecalcCount || 0) > 0) {
      printSnapSection('表头全量终态', pickMainKeys(epoch.finalSnap));
    }

    if (hasDetailKeys(epoch.finalSnap, epoch.changedSample) || (epoch.scope?.detailRowsInChangedSet || 0) > 0) {
      const detailSnap = pickDetailKeys(epoch.finalSnap, epoch.changedSample);
      const detailLabel = detailPathHint
        ? `明细变更行终态 · ${detailPathHint}`
        : '明细变更行终态';
      printSnapSection(detailLabel, detailSnap);
    }

    if (isDebugMode()) {
      scopeLog('debug: 完整数据 → __StateScope__.getLastEpoch() / __StateScope__.diagnoseLastEpoch()');
    }

    if (isVerboseMode()) {
      scopeLog('verbose changedSample', epoch.changedSample);
      scopeLog('verbose finalSnap', epoch.finalSnap);
    }

    scopeLog(`── Epoch #${epoch.id} end ──`);
    return;
  }

  if (diffs.length === 0) {
    scopeLog(`${header} | no top-level state keys`);
    return;
  }

  if (logicMismatches.length === 0 && mismatches.length === 0) {
    scopeLog(`${header} | ✅ ${diffs.length} field(s) aligned`);
    if (scopeLine) {
      scopeLog(`scope: ${scopeLine}`);
    }
    printSnapSection('终态', epoch.finalSnap);
    return;
  }

  scopeLog(
    `${header} | ${logicMismatches.length} logic / ${mismatches.length} total mismatch(es) / ${diffs.length} key(s)`
  );
  scopeLog(`route: ${meta.route} | action: ${meta.action}`);
  if (scopeLine) {
    scopeLog(`scope: ${scopeLine}`);
  }

  const lines = (logicMismatches.length > 0 ? logicMismatches : mismatches).slice(0, MAX_DETAIL_LINES);
  for (const item of lines) {
    scopeLog(`❌ ${item.path} | old=${formatVal(item.old)} new=${formatVal(item.new)} | ${item.severity}`);
  }

  if (mismatches.length > MAX_DETAIL_LINES) {
    scopeLog(`… +${mismatches.length - MAX_DETAIL_LINES} more (stateScopeVerbose=true for full dump)`);
  }

  printSnapSection('变更集终态', epoch.finalSnap);

  if (isVerboseMode()) {
    scopeLog('verbose oldSnap', epoch.oldSnap);
    scopeLog('verbose newSnap', epoch.newSnap);
    scopeLog('verbose diffs', diffs);
  }
}

function formatVal(value) {
  return formatValLong(value);
}

export { SEVERITY };
