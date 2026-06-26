import { formatDetailPathHintForDiagnose } from './legacy-diagnostics.js';

const MAX_EPOCH_HISTORY = 20;

let lastEpoch = null;
let epochHistory = [];

export function isDebugMode() {
  try {
    return localStorage.getItem('stateScopeDebug') === 'true';
  } catch {
    return false;
  }
}

export function storeEpoch(epoch, meta) {
  const record = {
    id: epoch.id,
    trigger: epoch.trigger,
    phase: epoch.phase,
    scope: epoch.scope,
    meta,
    changedSample: { ...epoch.changedSample },
    finalSnap: { ...epoch.finalSnap },
    oldSnap: { ...epoch.oldSnap },
    newSnap: { ...epoch.newSnap },
    storedAt: Date.now()
  };

  lastEpoch = record;
  epochHistory = [record, ...epochHistory].slice(0, MAX_EPOCH_HISTORY);
  return record;
}

export function getLastEpoch() {
  return lastEpoch;
}

export function getEpochHistory() {
  return epochHistory;
}

export function diagnoseEpoch(epoch = lastEpoch) {
  if (!epoch) {
    return { error: 'no epoch stored yet' };
  }

  const changedKeys = Object.keys(epoch.changedSample || {});
  const finalKeys = Object.keys(epoch.finalSnap || {});
  const changedSet = new Set(changedKeys);
  const finalSet = new Set(finalKeys);

  const intersection = changedKeys.filter((key) => finalSet.has(key));
  const onlyInChanged = changedKeys.filter((key) => !finalSet.has(key));
  const onlyInFinal = finalKeys.filter((key) => !changedSet.has(key));

  return {
    epochId: epoch.id,
    trigger: epoch.trigger,
    counts: {
      changedSample: changedKeys.length,
      finalSnap: finalKeys.length,
      intersection: intersection.length,
      onlyInChanged: onlyInChanged.length,
      onlyInFinal: onlyInFinal.length
    },
    sampleKeys: {
      changedSample: changedKeys.slice(0, 8),
      finalSnap: finalKeys.slice(0, 8),
      onlyInChanged: onlyInChanged.slice(0, 8),
      onlyInFinal: onlyInFinal.slice(0, 8)
    },
    detailPaths: formatDetailPathHintForDiagnose(epoch.finalSnap, epoch.changedSample),
    scope: epoch.scope
  };
}

export function installDebugApi(windowRef, logFn) {
  const api = windowRef.__StateScope__ || {};

  api.getLastEpoch = () => lastEpoch;
  api.getEpochHistory = () => epochHistory;
  api.diagnoseLastEpoch = () => diagnoseEpoch(lastEpoch);
  api.dumpLastEpoch = () => {
    if (!lastEpoch) {
      logFn('[StateScope] dumpLastEpoch: 尚无 epoch，请先操作单据触发 refreshView');
      return null;
    }
    logFn('[StateScope] dumpLastEpoch → 见下方对象，或复制 JSON:');
    logFn(JSON.stringify(lastEpoch, null, 2));
    return lastEpoch;
  };

  windowRef.__StateScope__ = api;
}
