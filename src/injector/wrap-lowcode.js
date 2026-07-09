import { isWrapped, markWrapped } from './discover.js';
import {
  bufferLowcodeFinal,
  bufferLowcodeOld,
  bufferLowcodeShadow,
  bufferLowcodeShadowFromPatches,
  bufferLowcodeShadowFromStore,
  peekLowcodePending
} from './lowcode-buffer.js';
import { buildLowcodeMainPath, buildLowcodePathFromGetDisable, resolveMainFieldModel } from './lowcode-paths.js';
import { flattenShadowStore, probeShadowSources } from './lowcode-shadow.js';

/** 与 OutsourceIssue StateTypeEnum / shadowStore __properties__ 对齐 */
export const LOWCODE_STATE_TYPES = ['visible', 'disabled'];

const RESULT_COMMIT_MS = 80;
const UI_STATE_COMMIT_MS = 900;
const MIN_DUPLICATE_EPOCH_MS = 2000;

let resultCommitTimer = null;
let resultCommitTrigger = 'afterBizAction';
let resultCommitPhase = 'incremental';
let uiStateCommitTimer = null;
let bootstrapEpochScheduled = false;
let lastCommitFingerprint = '';
let lastCommitAt = 0;

function stableSnapFingerprint(...snaps) {
  const merged = {};
  for (const snap of snaps) {
    Object.assign(merged, snap || {});
  }
  return Object.keys(merged)
    .sort()
    .map((key) => `${key}=${merged[key]}`)
    .join('|');
}

function shouldSkipDuplicateEpoch(trigger, fingerprint) {
  const now = Date.now();
  if (fingerprint === lastCommitFingerprint && now - lastCommitAt < MIN_DUPLICATE_EPOCH_MS) {
    return true;
  }
  lastCommitFingerprint = fingerprint;
  lastCommitAt = now;
  return false;
}

const DEFAULT_ALLOWLIST_FIELDS = [
  { path: 'main.currencyId', stateType: 'disabled' },
  { path: 'main.exchangeRate', stateType: 'disabled' },
  { path: 'main.redBlueFlagEnum', stateType: 'disabled' },
  { path: 'main.vendorId', stateType: 'disabled' }
];

function recordFieldStateSample(name, index, obj, stateType, value) {
  if (typeof value !== 'boolean') {
    return;
  }
  const path = buildLowcodePathFromGetDisable(name, index, obj, stateType);
  bufferLowcodeOld({ [path]: value });
  bufferLowcodeFinal({ [path]: value });
}

function collectBizAppsFromServicesList(card) {
  const bizs = [];
  if (!card) {
    return bizs;
  }
  const list = card.servicesList || card._servicesList;
  if (!Array.isArray(list)) {
    return bizs;
  }
  for (const pack of list) {
    for (const biz of pack?.bizs || []) {
      if (typeof biz?.doDispatch === 'function' && !bizs.includes(biz)) {
        bizs.push(biz);
      }
    }
  }
  return bizs;
}

function pickPreferredBizApp(candidates) {
  if (!candidates.length) {
    return null;
  }
  return (
    candidates.find((biz) => biz.interlayerViewModel?.rootViewModel) ||
    candidates.find((biz) => biz.interlayerViewModel) ||
    candidates.find((biz) => biz.stateManager) ||
    candidates[0]
  );
}

function findBizAppFromServicesList(card) {
  return pickPreferredBizApp(collectBizAppsFromServicesList(card));
}

export function discoverMdfBizApplication(viewModel) {
  if (!viewModel) {
    return null;
  }

  const card =
    viewModel.biz ||
    viewModel.root?.biz ||
    (typeof viewModel.get === 'function' ? viewModel.get('biz') : null);

  const fromServices = findBizAppFromServicesList(card);
  if (fromServices) {
    return fromServices;
  }

  const chain = [card, viewModel, viewModel.root, viewModel.interlayerViewModel].filter(Boolean);

  for (const candidate of chain) {
    if (typeof candidate.doDispatch === 'function') {
      return candidate;
    }
    const nested = findBizAppFromServicesList(candidate);
    if (nested) {
      return nested;
    }
  }

  return null;
}

export function discoverLowcodeInterlayer(viewModel, bizApp) {
  const direct = [
    bizApp?.interlayerViewModel,
    viewModel?.interlayerViewModel,
    resolveRootViewModel(viewModel)?.interlayerViewModel
  ].filter(Boolean);

  for (const item of direct) {
    if (typeof item?.syncChangedFields === 'function') {
      return item;
    }
  }

  const scanTargets = [bizApp, viewModel, viewModel?.root, viewModel?.biz, discoverLowcodeCard(viewModel)].filter(
    Boolean
  );
  for (const target of scanTargets) {
    try {
      for (const value of Object.values(target)) {
        if (value && typeof value === 'object' && typeof value.syncChangedFields === 'function') {
          return value;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/** afterBizAction / getDisable 实际挂在 interlayer.rootViewModel 上 */
export function resolveLowcodeUiRoot(viewModel, bizApp) {
  const interlayer = discoverLowcodeInterlayer(viewModel, bizApp);
  if (interlayer?.rootViewModel) {
    return interlayer.rootViewModel;
  }
  const mdfBiz = bizApp || discoverMdfBizApplication(viewModel);
  if (mdfBiz?.interlayerViewModel?.rootViewModel) {
    return mdfBiz.interlayerViewModel.rootViewModel;
  }
  return resolveRootViewModel(viewModel);
}

function collectAfterBizActionRoots(viewModel, bizApp) {
  const roots = new Set();
  const uiRoot = resolveLowcodeUiRoot(viewModel, bizApp);
  if (uiRoot) {
    roots.add(uiRoot);
  }
  const primary = resolveRootViewModel(viewModel);
  if (primary) {
    roots.add(primary);
  }
  const interlayer = discoverLowcodeInterlayer(viewModel, bizApp);
  if (interlayer?.rootViewModel) {
    roots.add(interlayer.rootViewModel);
  }
  return [...roots].filter((root) => root && typeof root.execute === 'function');
}

function resolveUiHookFn(root, propName) {
  if (!root) {
    return null;
  }
  let fn = null;
  try {
    fn = root.get?.(propName);
  } catch {
    fn = null;
  }
  if (typeof fn === 'function') {
    return fn;
  }
  fn = root.cache?.[propName];
  return typeof fn === 'function' ? fn : null;
}

export function discoverLowcodeCard(viewModel) {
  if (!viewModel) {
    return null;
  }
  return (
    viewModel.biz ||
    viewModel.root?.biz ||
    (typeof viewModel.get === 'function' ? viewModel.get('biz') : null)
  );
}

function resolveRootViewModel(viewModel) {
  return viewModel?.root || viewModel;
}

function readModelStateType(model, stateType) {
  if (!model || typeof model.get !== 'function') {
    return undefined;
  }
  try {
    const value = model.get(stateType);
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 表头 allowlist 主动采样：按 field.stateType 读 visible/disabled 终态。
 * L2 仅对比字段状态（visible/disabled），不对比字段值。
 */
function sampleAllowlistFieldStatesFromViewModel(viewModel, allowlistConfig) {
  if (!viewModel) {
    return {};
  }

  const snap = {};
  const fields = allowlistConfig?.fields?.length ? allowlistConfig.fields : DEFAULT_ALLOWLIST_FIELDS;
  const sampledMain = new Set();

  for (const field of fields) {
    const path = field.path;
    if (!path || path.includes('{uuid}') || !path.startsWith('main.')) {
      continue;
    }

    const fieldName = path.slice('main.'.length);
    const model = resolveMainFieldModel(viewModel, path);
    if (!model) {
      continue;
    }

    const primaryType = field.stateType || 'disabled';
    const typesToSample =
      sampledMain.has(fieldName) ?
        [primaryType]
      : LOWCODE_STATE_TYPES;

    for (const stateType of typesToSample) {
      const value = readModelStateType(model, stateType);
      if (typeof value === 'boolean') {
        snap[buildLowcodeMainPath(fieldName, stateType)] = value;
      }
    }
    sampledMain.add(fieldName);
  }

  return snap;
}

/**
 * 低代码 L2 结果采样：
 * - final/old = 用户所见（fieldModel visible/disabled + getDisable/getVisible 读路径）
 * - shadow = shadowStore 终态（visible + disabled）
 */
export function commitLowcodeEpoch(epochManager, getContext, trigger, phase = 'incremental', bizAppHint) {
  if (!epochManager) {
    return false;
  }

  const { viewModel, allowlistConfig } = getContext() || {};
  const root = resolveRootViewModel(viewModel);
  const bizApp = bizAppHint || discoverMdfBizApplication(viewModel);

  const shadowSnap = flattenShadowStore(root, bizApp, allowlistConfig) || {};
  if (Object.keys(shadowSnap).length) {
    bufferLowcodeShadow(shadowSnap);
  }

  const visibleSnap = sampleAllowlistFieldStatesFromViewModel(viewModel, allowlistConfig);
  if (Object.keys(visibleSnap).length) {
    bufferLowcodeOld(visibleSnap);
    bufferLowcodeFinal(visibleSnap);
  }

  const pending = peekLowcodePending();
  const hasAny =
    Object.keys(pending.old).length +
      Object.keys(pending.final).length +
      Object.keys(pending.shadow).length +
      Object.keys(shadowSnap).length >
    0;

  if (!hasAny) {
    return false;
  }

  const fingerprint = stableSnapFingerprint(pending.final, pending.shadow, shadowSnap, visibleSnap);
  if (shouldSkipDuplicateEpoch(String(trigger), fingerprint)) {
    return false;
  }

  epochManager.beginEpoch(String(trigger), phase);
  if (Object.keys(shadowSnap).length) {
    epochManager.recordShadow?.(shadowSnap);
  }
  if (Object.keys(visibleSnap).length) {
    epochManager.recordFinal?.(visibleSnap);
    epochManager.recordOld?.(visibleSnap);
  }
  epochManager.commitEpoch();
  return true;
}

function scheduleUiStateEpochCommit(epochManager, getContext, bizApp) {
  if (!epochManager) {
    return;
  }
  if (uiStateCommitTimer) {
    clearTimeout(uiStateCommitTimer);
  }
  uiStateCommitTimer = setTimeout(() => {
    uiStateCommitTimer = null;
    commitLowcodeEpoch(epochManager, getContext, 'uiStateChange', 'incremental', bizApp);
  }, UI_STATE_COMMIT_MS);
}

function scheduleBootstrapEpoch(epochManager, getContext, bizApp) {
  if (!epochManager || bootstrapEpochScheduled) {
    return;
  }
  bootstrapEpochScheduled = true;
  setTimeout(() => {
    commitLowcodeEpoch(epochManager, getContext, 'bootstrap', 'init-full', bizApp);
  }, 400);
}

function scheduleResultEpochCommit(epochManager, getContext, trigger, phase, bizApp) {
  if (!epochManager) {
    return;
  }
  resultCommitTrigger = trigger;
  resultCommitPhase = phase || 'incremental';
  if (resultCommitTimer) {
    clearTimeout(resultCommitTimer);
  }
  resultCommitTimer = setTimeout(() => {
    resultCommitTimer = null;
    commitLowcodeEpoch(epochManager, getContext, resultCommitTrigger, resultCommitPhase, bizApp);
  }, RESULT_COMMIT_MS);
}

function wrapUiStateReader(uiRoot, getContext, bizApp, epochManager, propName, stateType) {
  if (!uiRoot || uiRoot.__stateScopeUiReaderWrapped?.[propName]) {
    return false;
  }

  const original = resolveUiHookFn(uiRoot, propName);
  if (typeof original !== 'function') {
    return false;
  }

  const wrapped = (name, index, obj) => {
    const result = original.call(uiRoot, name, index, obj);
    recordFieldStateSample(name, index, obj, stateType, !!result);
    scheduleUiStateEpochCommit(epochManager, getContext, bizApp);
    return result;
  };

  try {
    if (typeof uiRoot.set === 'function') {
      uiRoot.set(propName, wrapped);
    } else {
      return false;
    }
  } catch {
    return false;
  }

  if (!uiRoot.__stateScopeUiReaderWrapped) {
    uiRoot.__stateScopeUiReaderWrapped = {};
  }
  uiRoot.__stateScopeUiReaderWrapped[propName] = true;
  return true;
}

/** UI 读路径：getDisable / getVisible → 用户所见 visible/disabled 终态 */
export function wrapGetDisable(viewModel, epochManager, getContext, bizApp) {
  if (!viewModel) {
    return false;
  }

  const uiRoot = resolveLowcodeUiRoot(viewModel, bizApp);
  if (!uiRoot || uiRoot.__stateScopeUiReaderHooked) {
    return !!uiRoot?.__stateScopeUiReaderHooked;
  }

  const disabledOk = wrapUiStateReader(uiRoot, getContext, bizApp, epochManager, 'getDisable', 'disabled');
  const visibleOk = wrapUiStateReader(uiRoot, getContext, bizApp, epochManager, 'getVisible', 'visible');

  if (!disabledOk && !visibleOk) {
    return false;
  }

  uiRoot.__stateScopeUiReaderHooked = true;
  return true;
}

function ensureLowcodeLazyHooks(viewModel, epochManager, getContext, bizApp) {
  if (!viewModel || !epochManager) {
    return;
  }

  const interlayer = discoverLowcodeInterlayer(viewModel, bizApp);
  if (interlayer && typeof interlayer.syncChangedFields === 'function' && !isWrapped(interlayer)) {
    wrapSyncChangedFields(interlayer);
  }

  wrapGetDisable(viewModel, epochManager, getContext, bizApp);
  wrapAfterBizAction(viewModel, epochManager, getContext, bizApp);
}

function resolveDispatchPhase(action) {
  const path = action?.path || action?.params?.path || '';
  const type = action?.type || '';
  if (type === 'init' || /initBlank|blank|load|edit|copy/i.test(String(path))) {
    return 'init-full';
  }
  return 'incremental';
}

/**
 * 统一包装 BizApplication：doDispatch 记录 trigger + applyStateAfterDataSync 后采 shadow。
 * applyStatePatches 是模块函数，挂在 applyStateAfterDataSync 之后读取 shadowStore。
 */
export function wrapMdfBizApplication(bizApp, epochManager, getContext = () => ({}), viewModel) {
  if (!bizApp || typeof bizApp.doDispatch !== 'function' || isWrapped(bizApp)) {
    return false;
  }

  const originalDispatch = bizApp.doDispatch.bind(bizApp);
  bizApp.doDispatch = async function doDispatchWrapped(action, callback) {
    ensureLowcodeLazyHooks(viewModel, epochManager, getContext, bizApp);
    const actionPath = action?.path || action?.params?.path || action?.type || 'doDispatch';
    bizApp.__stateScopeLastAction = actionPath;
    bizApp.__stateScopeLastPhase = resolveDispatchPhase(action);
    return originalDispatch(action, callback);
  };

  if (typeof bizApp.applyStateAfterDataSync === 'function') {
    const originalApply = bizApp.applyStateAfterDataSync.bind(bizApp);
    bizApp.applyStateAfterDataSync = async function applyStateAfterDataSyncWrapped(
      changedPatches,
      statePatches
    ) {
      const result = await originalApply(changedPatches, statePatches);
      try {
        const ctx = getContext();
        const vm = ctx?.viewModel || viewModel;
        bufferLowcodeShadowFromStore(
          resolveRootViewModel(vm),
          bizApp,
          ctx?.allowlistConfig
        );
        if (statePatches && Object.keys(statePatches).length) {
          bufferLowcodeShadowFromPatches(statePatches, 'shadow');
        }
      } catch {
        // ignore
      }
      return result;
    };
  }

  const stateManager = bizApp.stateManager;
  if (stateManager && typeof stateManager.recomputeStatesForPatches === 'function' && !stateManager.__stateScopeRecomputeWrapped) {
    const originalRecompute = stateManager.recomputeStatesForPatches.bind(stateManager);
    stateManager.recomputeStatesForPatches = async function recomputeWrapped(patches) {
      const result = await originalRecompute(patches);
      try {
        const ctx = getContext();
        bufferLowcodeShadowFromStore(
          resolveRootViewModel(ctx?.viewModel || viewModel),
          bizApp,
          ctx?.allowlistConfig
        );
      } catch {
        // ignore
      }
      return result;
    };
    stateManager.__stateScopeRecomputeWrapped = true;
  }

  markWrapped(bizApp);
  return true;
}

export function wrapMdfDoDispatch(bizApp, epochManager, getContext, viewModel) {
  return wrapMdfBizApplication(bizApp, epochManager, getContext, viewModel);
}

/**
 * syncChangedFields 只同步 UI 字段值；shadow 在 applyStateAfterDataSync 之后。
 * Epoch 统一由 afterBizAction 边界提交，此处不 commit。
 */
export function wrapSyncChangedFields(interlayer) {
  if (!interlayer || typeof interlayer.syncChangedFields !== 'function' || isWrapped(interlayer)) {
    return false;
  }

  const original = interlayer.syncChangedFields.bind(interlayer);

  interlayer.syncChangedFields = async function syncChangedFieldsWrapped(changedFields) {
    return original(changedFields);
  };

  markWrapped(interlayer);
  return true;
}

/**
 * 低代码 Epoch 主边界：doDispatch finally 里的 execute('afterBizAction')。
 * 挂在 interlayer.rootViewModel.execute（与 BizApplication 一致）。
 */
export function wrapAfterBizAction(viewModel, epochManager, getContext, bizApp) {
  const roots = collectAfterBizActionRoots(viewModel, bizApp);
  if (!roots.length) {
    return false;
  }

  let wrappedAny = false;

  for (const root of roots) {
    if (root.__stateScopeAfterBizWrapped) {
      wrappedAny = true;
      continue;
    }

    const original = root.execute.bind(root);

    root.execute = async function executeWrapped(actionName, ...args) {
      const result = await original(actionName, ...args);
      if (actionName === 'afterBizAction') {
        try {
          const activeBiz = bizApp || discoverMdfBizApplication(viewModel);
          const trigger = activeBiz?.__stateScopeLastAction || 'afterBizAction';
          const phase = activeBiz?.__stateScopeLastPhase || 'incremental';
          scheduleResultEpochCommit(epochManager, getContext, trigger, phase, activeBiz);
        } catch {
          // ignore
        }
      }
      return result;
    };

    root.__stateScopeAfterBizWrapped = true;
    wrappedAny = true;
  }

  return wrappedAny;
}

export function probeLowcodeShadow(viewModel, allowlistConfig, bizAppHint) {
  const bizApp = bizAppHint || discoverMdfBizApplication(viewModel);
  return probeShadowSources(viewModel, bizApp, allowlistConfig);
}

export function wrapLowcodeRuntime(viewModel, epochManager, getContext = () => ({})) {
  if (!viewModel) {
    return {
      getDisable: false,
      doDispatch: false,
      syncChangedFields: false,
      afterBizAction: false,
      bizApp: false,
      card: false
    };
  }

  const bizApp = discoverMdfBizApplication(viewModel);
  const interlayer = discoverLowcodeInterlayer(viewModel, bizApp);
  const card = discoverLowcodeCard(viewModel);
  const ctxGetter = () => ({
    viewModel,
    ...(typeof getContext === 'function' ? getContext() : {})
  });

  const hooks = {
    getDisable: wrapGetDisable(viewModel, epochManager, ctxGetter, bizApp),
    doDispatch: wrapMdfBizApplication(bizApp, epochManager, ctxGetter, viewModel),
    syncChangedFields: wrapSyncChangedFields(interlayer),
    afterBizAction: wrapAfterBizAction(viewModel, epochManager, ctxGetter, bizApp),
    bizApp: !!bizApp,
    card: !!card,
    interlayer: !!interlayer,
    stateManager: !!bizApp?.stateManager,
    uiRoot: !!resolveLowcodeUiRoot(viewModel, bizApp),
    getDisableReady: !!resolveUiHookFn(resolveLowcodeUiRoot(viewModel, bizApp), 'getDisable')
  };

  if (hooks.doDispatch || hooks.afterBizAction || hooks.getDisable) {
    scheduleBootstrapEpoch(epochManager, ctxGetter, bizApp);
  }

  return hooks;
}

export { wrapGetDisable as wrapGetDisableLegacy };
