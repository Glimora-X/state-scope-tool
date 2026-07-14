import { captureStatePatchesAsSnap } from './normalize.js';
import { isWrapped, markWrapped, unmarkWrapped } from './discover.js';
import { registerHook, markTriggered } from './hook-registry.js';

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

  const rawDispatch = bizApplication.dispatchAction;
  if (typeof rawDispatch !== 'function') {
    return false;
  }

  const original = rawDispatch.bind(bizApplication);

  const wrapped = async function dispatchActionWrapped(action, cb) {
    markTriggered('dispatchAction');
    const actionPath = action?.path || action?.params?.path || action?.type || 'unknown';
    const result = await original(action, cb);

    if (result?.statePatches && Object.keys(result.statePatches).length > 0) {
      epochManager.beginEpoch(String(actionPath), resolveDispatchPhase(action));
      epochManager.recordNew(captureStatePatchesAsSnap(result.statePatches));
      epochManager.commitEpoch();
    }

    return result;
  };
  bizApplication.dispatchAction = wrapped;

  registerHook({
    name: 'dispatchAction',
    target: bizApplication,
    methodName: 'dispatchAction',
    original: rawDispatch,
    wrapped,
    onUnwrap() {
      bizApplication.dispatchAction = rawDispatch;
      unmarkWrapped(bizApplication);
    }
  });

  markWrapped(bizApplication);
  return true;
}

export function wrapComputeInitialStates(stateManager, epochManager) {
  if (!stateManager || isWrapped(stateManager)) {
    return false;
  }

  const rawCompute = stateManager.computeInitialStates;
  if (typeof rawCompute !== 'function') {
    return false;
  }

  const original = rawCompute.bind(stateManager);

  const wrapped = async function computeInitialStatesWrapped(...args) {
    markTriggered('computeInitialStates');
    const patches = await original(...args);

    if (patches && Object.keys(patches).length > 0) {
      epochManager.beginEpoch('computeInitialStates', 'init-full');
      epochManager.recordNew(captureStatePatchesAsSnap(patches));
      epochManager.commitEpoch();
    }

    return patches;
  };
  stateManager.computeInitialStates = wrapped;

  registerHook({
    name: 'computeInitialStates',
    target: stateManager,
    methodName: 'computeInitialStates',
    original: rawCompute,
    wrapped,
    onUnwrap() {
      stateManager.computeInitialStates = rawCompute;
      unmarkWrapped(stateManager);
    }
  });

  markWrapped(stateManager);
  return true;
}
