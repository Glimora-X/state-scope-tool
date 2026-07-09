import { captureStatePatchesAsSnap } from './normalize.js';
import { isWrapped, markWrapped } from './discover.js';

const INIT_FULL_COMMAND_PATHS = new Set(['initBlank', 'blank', 'load', 'edit', 'copy']);

function resolveDispatchPhase(action) {
  if (action?.type === 'init') {
    return 'init-full';
  }
  if (action?.type === 'command' && INIT_FULL_COMMAND_PATHS.has(action.path)) {
    return 'init-full';
  }
  return 'incremental';
}

export function wrapDispatchAction(bizApplication, epochManager) {
  if (!bizApplication || isWrapped(bizApplication)) {
    return false;
  }

  const original = bizApplication.dispatchAction?.bind(bizApplication);
  if (typeof original !== 'function') {
    return false;
  }

  bizApplication.dispatchAction = async function dispatchActionWrapped(action, cb) {
    const actionPath = action?.path || action?.params?.path || action?.type || 'unknown';
    const result = await original(action, cb);

    if (result?.statePatches && Object.keys(result.statePatches).length > 0) {
      epochManager.beginEpoch(String(actionPath), resolveDispatchPhase(action));
      epochManager.recordNew(captureStatePatchesAsSnap(result.statePatches));
      epochManager.commitEpoch();
    }

    return result;
  };

  markWrapped(bizApplication);
  return true;
}

export function wrapComputeInitialStates(stateManager, epochManager) {
  if (!stateManager || isWrapped(stateManager)) {
    return false;
  }

  const original = stateManager.computeInitialStates?.bind(stateManager);
  if (typeof original !== 'function') {
    return false;
  }

  stateManager.computeInitialStates = async function computeInitialStatesWrapped(...args) {
    const patches = await original(...args);

    if (patches && Object.keys(patches).length > 0) {
      epochManager.beginEpoch('computeInitialStates', 'init-full');
      epochManager.recordNew(captureStatePatchesAsSnap(patches));
      epochManager.commitEpoch();
    }

    return patches;
  };

  markWrapped(stateManager);
  return true;
}
