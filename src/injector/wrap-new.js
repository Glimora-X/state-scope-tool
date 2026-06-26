import { flattenStatePatches } from './normalize.js';
import { filterTopLevelEntries } from './path-filter.js';
import { isWrapped, markWrapped } from './discover.js';

export function wrapDispatchAction(bizApplication, epochManager) {
  if (!bizApplication || isWrapped(bizApplication)) {
    return;
  }

  const original = bizApplication.dispatchAction?.bind(bizApplication);
  if (typeof original !== 'function') {
    return;
  }

  bizApplication.dispatchAction = async function dispatchActionWrapped(action, cb) {
    const actionPath = action?.path || action?.params?.path || 'unknown';
    const result = await original(action, cb);

    if (result?.statePatches && Object.keys(result.statePatches).length > 0) {
      epochManager.beginEpoch(actionPath, 'incremental');
      epochManager.recordNew(filterTopLevelEntries(flattenStatePatches(result.statePatches)));
      epochManager.commitEpoch();
    }

    return result;
  };

  markWrapped(bizApplication);
}

export function wrapComputeInitialStates(stateManager, epochManager) {
  if (!stateManager || isWrapped(stateManager)) {
    return;
  }

  const original = stateManager.computeInitialStates?.bind(stateManager);
  if (typeof original !== 'function') {
    return;
  }

  stateManager.computeInitialStates = async function computeInitialStatesWrapped(...args) {
    const patches = await original(...args);

    if (patches && Object.keys(patches).length > 0) {
      epochManager.beginEpoch('computeInitialStates', 'init-full');
      epochManager.recordNew(filterTopLevelEntries(flattenStatePatches(patches)));
      epochManager.commitEpoch();
    }

    return patches;
  };

  markWrapped(stateManager);
}
