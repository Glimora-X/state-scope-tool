/**
 * 低代码（lowcode）取证模型
 *
 * Diff 轴：可见态（visibleSnap）vs 影子态（shadowSnap）
 * - 可见态 = 用户所见 / getDisable·getVisible 读路径 / fieldModel 终态
 * - 影子态 = shadowStore / applyStatePatches 写入的升级后状态
 *
 * 映射到 epoch 字段：
 *   oldSnap   ← visibleSnap（命名残留，与 traditional 含义不同）
 *   finalSnap ← visibleSnap（同 oldSnap，用于兼容传统线消费逻辑）
 *   newSnap   ← 通常为空
 *   shadowSnap← shadowStore 终态
 */
import { isWrapped, markWrapped, unmarkWrapped } from './discover.js';
import { registerHook, markTriggered } from './hook-registry.js';
import {
  bufferLowcodeFinal,
  bufferLowcodeOld,
  bufferLowcodeShadow,
  bufferLowcodeShadowFromPatches,
  bufferLowcodeShadowFromStore,
  peekLowcodePending,
  getSessionToken
} from './lowcode-buffer.js';
import { buildLowcodePathFromGetDisable } from './lowcode-paths.js';
import {
  LOWCODE_STATE_TYPES,
  sampleAllowlistFieldStatesFromViewModel as sampleAllowlistFields
} from './lowcode-sample.js';
import { flattenShadowStore, probeShadowSources } from './lowcode-shadow.js';
import { scopeLog } from './safe-log.js';

/** 与 OutsourceIssue StateTypeEnum / shadowStore __properties__ 对齐 */
export { LOWCODE_STATE_TYPES };

const RESULT_COMMIT_MS = 300;
const UI_STATE_COMMIT_MS = 900;
const MIN_DUPLICATE_EPOCH_MS = 2000;
const BOOTSTRAP_INITIAL_DELAY_MS = 400;
const BOOTSTRAP_RETRY_DELAYS = [2000, 5000];

let resultCommitTimer = null;
let resultCommitTrigger = 'afterBizAction';
let resultCommitPhase = 'incremental';
let uiStateCommitTimer = null;
let bootstrapAttempt = 0;
let bootstrapComplete = false;
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
  const key = `${trigger}::${fingerprint}`;
  if (key === lastCommitFingerprint && now - lastCommitAt < MIN_DUPLICATE_EPOCH_MS) {
    return true;
  }
  lastCommitFingerprint = key;
  lastCommitAt = now;
  return false;
}

const DEFAULT_ALLOWLIST_FIELDS = [
  { path: 'main.currencyId', stateType: 'disabled' },
  { path: 'main.exchangeRate', stateType: 'disabled' },
  { path: 'main.redBlueFlagEnum', stateType: 'disabled' },
  { path: 'main.vendorId', stateType: 'disabled' },
  { path: 'detailList.{uuid}.warehouseId', stateType: 'disabled' }
];

function recordFieldStateSample(name, index, obj, stateType, value, sessionToken) {
  if (typeof value !== 'boolean') {
    return;
  }
  const path = buildLowcodePathFromGetDisable(name, index, obj, stateType);
  bufferLowcodeOld({ [path]: value }, sessionToken);
  bufferLowcodeFinal({ [path]: value }, sessionToken);
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

/** 表头 + 明细 allowlist 主动采样（明细不再跳过 {uuid}） */
export function sampleAllowlistFieldStatesFromViewModel(viewModel, allowlistConfig) {
  return sampleAllowlistFields(viewModel, allowlistConfig, DEFAULT_ALLOWLIST_FIELDS);
}

/**
 * 低代码 L2 结果采样：
 * - final/old = 用户所见（fieldModel / column disabled + getDisable 读路径）
 * - shadow = shadowStore 终态（visible + disabled）
 */
export function commitLowcodeEpoch(
  epochManager,
  getContext,
  trigger,
  phase = 'incremental',
  bizAppHint,
  options = {}
) {
  if (!epochManager) {
    return false;
  }

  const sessionToken = options.sessionToken || getSessionToken();
  if (sessionToken && getSessionToken() && sessionToken !== getSessionToken()) {
    return false;
  }

  const force = !!options.force;
  const isBootstrap = !!options.isBootstrap;
  const { viewModel, allowlistConfig } = getContext() || {};
  const root = resolveRootViewModel(viewModel);
  const bizApp = bizAppHint || discoverMdfBizApplication(viewModel);

  const token = getSessionToken();
  const shadowSnap = flattenShadowStore(root, bizApp, allowlistConfig) || {};
  const shadowCaptured = Object.keys(shadowSnap).length > 0;
  if (shadowCaptured) {
    bufferLowcodeShadow(shadowSnap, token);
  }

  const visibleSnap = sampleAllowlistFieldStatesFromViewModel(viewModel, allowlistConfig);
  if (Object.keys(visibleSnap).length) {
    // lowcode 模式下 oldSnap 与 finalSnap 均写入可见态（visibleSnap），
    // 因为 Diff 旧侧取 finalSnap 作为"用户所见"，oldSnap 仅为兼容保留
    bufferLowcodeOld(visibleSnap, token);
    bufferLowcodeFinal(visibleSnap, token);
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
  if (!force && shouldSkipDuplicateEpoch(String(trigger), fingerprint)) {
    return false;
  }
  if (force) {
    lastCommitFingerprint = `${trigger}::${fingerprint}`;
    lastCommitAt = Date.now();
  }

  const bootstrapQuality = isBootstrap ? (shadowCaptured ? 'complete' : 'partial') : undefined;

  epochManager.beginEpoch(String(trigger), phase);
  epochManager.setMeta?.({ isBootstrap, shadowCaptured, bootstrapQuality });
  if (shadowCaptured) {
    epochManager.recordShadow?.(shadowSnap);
  }
  if (Object.keys(visibleSnap).length) {
    epochManager.recordFinal?.(visibleSnap);
    epochManager.recordOld?.(visibleSnap);
  }
  epochManager.commitEpoch();
  return { committed: true, shadowCaptured, isBootstrap, bootstrapQuality };
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
  if (!epochManager || bootstrapComplete) {
    return;
  }

  const delay = bootstrapAttempt === 0
    ? BOOTSTRAP_INITIAL_DELAY_MS
    : BOOTSTRAP_RETRY_DELAYS[bootstrapAttempt - 1];

  if (delay === undefined) {
    scopeLog('bootstrap: 重试次数用尽，shadowStore 可能尚未接入');
    return;
  }

  const currentAttempt = bootstrapAttempt;
  bootstrapAttempt += 1;

  setTimeout(() => {
    try {
      const result = commitLowcodeEpoch(
        epochManager, getContext, 'bootstrap', 'init-full', bizApp,
        { force: true, isBootstrap: true }
      );

      if (result && result.shadowCaptured) {
        bootstrapComplete = true;
        scopeLog('bootstrap: 初始化态采集完成');
      } else if (currentAttempt < BOOTSTRAP_RETRY_DELAYS.length) {
        scopeLog(
          `bootstrap: shadowSnap 为空，${BOOTSTRAP_RETRY_DELAYS[currentAttempt]}ms 后重试` +
          ` (${currentAttempt + 1}/${BOOTSTRAP_RETRY_DELAYS.length + 1})`
        );
        scheduleBootstrapEpoch(epochManager, getContext, bizApp);
      } else {
        // 最终仍无 shadow：至少留下一帧 visible 采样，避免「空白打开」时间线空白
        const visibleOnly = commitLowcodeEpoch(
          epochManager, getContext, 'bootstrap-visible', 'init-full', bizApp,
          { force: true, isBootstrap: true }
        );
        bootstrapComplete = true;
        scopeLog(
          visibleOnly?.committed
            ? 'bootstrap: shadow 仍空，已写入可见态 init Epoch（可继续改字段或点采样）'
            : 'bootstrap: 最终尝试完成，shadowSnap/visibleSnap 均空'
        );
      }
    } catch (err) {
      scopeLog('bootstrap: 采集异常', err);
    }
  }, delay);
}

/** 同 BO 路由跳转（列表→新增空白）时重新采 init Epoch */
export function requestBootstrapResample(epochManager, getContext, bizApp) {
  if (!epochManager) {
    return false;
  }
  resetBootstrapState();
  scheduleBootstrapEpoch(epochManager, getContext, bizApp);
  return true;
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

  const hookSessionToken = getSessionToken();

  const wrapped = (name, index, obj) => {
    markTriggered(propName);
    const result = original.call(uiRoot, name, index, obj);
    const currentToken = getSessionToken();
    if (!hookSessionToken || !currentToken || hookSessionToken === currentToken) {
      recordFieldStateSample(name, index, obj, stateType, !!result, currentToken);
      scheduleUiStateEpochCommit(epochManager, getContext, bizApp);
    }
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

  registerHook({
    name: propName,
    target: uiRoot,
    methodName: propName,
    original,
    wrapped,
    resolveCurrent: () => resolveUiHookFn(uiRoot, propName),
    onUnwrap() {
      try { uiRoot.set(propName, original); } catch { /* ignore */ }
      if (uiRoot.__stateScopeUiReaderWrapped) {
        delete uiRoot.__stateScopeUiReaderWrapped[propName];
      }
      if (!uiRoot.__stateScopeUiReaderWrapped?.getDisable && !uiRoot.__stateScopeUiReaderWrapped?.getVisible) {
        delete uiRoot.__stateScopeUiReaderHooked;
      }
    }
  });

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

  const hookSessionToken = getSessionToken();

  const rawDoDispatch = bizApp.doDispatch;
  const originalDispatch = rawDoDispatch.bind(bizApp);
  const wrappedDispatch = async function doDispatchWrapped(action, callback) {
    markTriggered('doDispatch');
    const currentToken = getSessionToken();
    const sessionActive = !hookSessionToken || !currentToken || hookSessionToken === currentToken;
    if (sessionActive) {
      ensureLowcodeLazyHooks(viewModel, epochManager, getContext, bizApp);
      const actionPath = action?.path || action?.params?.path || action?.type || 'doDispatch';
      bizApp.__stateScopeLastAction = actionPath;
      bizApp.__stateScopeLastPhase = resolveDispatchPhase(action);
    }
    return originalDispatch(action, callback);
  };
  bizApp.doDispatch = wrappedDispatch;

  registerHook({
    name: 'doDispatch',
    target: bizApp,
    methodName: 'doDispatch',
    original: rawDoDispatch,
    wrapped: wrappedDispatch,
    onUnwrap() {
      bizApp.doDispatch = rawDoDispatch;
      unmarkWrapped(bizApp);
    }
  });

  if (typeof bizApp.applyStateAfterDataSync === 'function') {
    const rawApply = bizApp.applyStateAfterDataSync;
    const originalApply = rawApply.bind(bizApp);
    const wrappedApply = async function applyStateAfterDataSyncWrapped(
      changedPatches,
      statePatches
    ) {
      markTriggered('applyStateAfterDataSync');
      const result = await originalApply(changedPatches, statePatches);
      const currentToken = getSessionToken();
      const sessionActive = !hookSessionToken || !currentToken || hookSessionToken === currentToken;
      if (sessionActive) {
        try {
          const ctx = getContext();
          const vm = ctx?.viewModel || viewModel;
          bufferLowcodeShadowFromStore(
            resolveRootViewModel(vm),
            bizApp,
            ctx?.allowlistConfig,
            currentToken
          );
          if (statePatches && Object.keys(statePatches).length) {
            bufferLowcodeShadowFromPatches(statePatches, 'shadow', currentToken);
          }
        } catch {
          // ignore
        }
      }
      return result;
    };
    bizApp.applyStateAfterDataSync = wrappedApply;

    registerHook({
      name: 'applyStateAfterDataSync',
      target: bizApp,
      methodName: 'applyStateAfterDataSync',
      original: rawApply,
      wrapped: wrappedApply,
      onUnwrap() {
        bizApp.applyStateAfterDataSync = rawApply;
      }
    });
  }

  const stateManager = bizApp.stateManager;
  if (stateManager && typeof stateManager.recomputeStatesForPatches === 'function' && !stateManager.__stateScopeRecomputeWrapped) {
    const rawRecompute = stateManager.recomputeStatesForPatches;
    const originalRecompute = rawRecompute.bind(stateManager);
    const wrappedRecompute = async function recomputeWrapped(patches) {
      markTriggered('recomputeStatesForPatches');
      const result = await originalRecompute(patches);
      const currentToken = getSessionToken();
      const sessionActive = !hookSessionToken || !currentToken || hookSessionToken === currentToken;
      if (sessionActive) {
        try {
          const ctx = getContext();
          bufferLowcodeShadowFromStore(
            resolveRootViewModel(ctx?.viewModel || viewModel),
            bizApp,
            ctx?.allowlistConfig,
            currentToken
          );
        } catch {
          // ignore
        }
      }
      return result;
    };
    stateManager.recomputeStatesForPatches = wrappedRecompute;
    stateManager.__stateScopeRecomputeWrapped = true;

    registerHook({
      name: 'recomputeStatesForPatches',
      target: stateManager,
      methodName: 'recomputeStatesForPatches',
      original: rawRecompute,
      wrapped: wrappedRecompute,
      onUnwrap() {
        stateManager.recomputeStatesForPatches = rawRecompute;
        delete stateManager.__stateScopeRecomputeWrapped;
      }
    });
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

  const rawSync = interlayer.syncChangedFields;
  const original = rawSync.bind(interlayer);

  const wrapped = async function syncChangedFieldsWrapped(changedFields) {
    markTriggered('syncChangedFields');
    return original(changedFields);
  };
  interlayer.syncChangedFields = wrapped;

  registerHook({
    name: 'syncChangedFields',
    target: interlayer,
    methodName: 'syncChangedFields',
    original: rawSync,
    wrapped,
    onUnwrap() {
      interlayer.syncChangedFields = rawSync;
      unmarkWrapped(interlayer);
    }
  });

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
  let afterBizIndex = 0;

  const hookSessionToken = getSessionToken();

  for (const root of roots) {
    if (root.__stateScopeAfterBizWrapped) {
      wrappedAny = true;
      continue;
    }

    const hookName = afterBizIndex === 0 ? 'afterBizAction' : `afterBizAction#${afterBizIndex}`;
    afterBizIndex += 1;

    const rawExecute = root.execute;
    const original = rawExecute.bind(root);

    const wrappedExecute = async function executeWrapped(actionName, ...args) {
      markTriggered(hookName);
      const result = await original(actionName, ...args);
      if (actionName === 'afterBizAction') {
        const currentToken = getSessionToken();
        const sessionActive = !hookSessionToken || !currentToken || hookSessionToken === currentToken;
        if (sessionActive) {
          try {
            const activeBiz = bizApp || discoverMdfBizApplication(viewModel);
            const trigger = activeBiz?.__stateScopeLastAction || 'afterBizAction';
            const phase = activeBiz?.__stateScopeLastPhase || 'incremental';
            scheduleResultEpochCommit(epochManager, getContext, trigger, phase, activeBiz);
          } catch {
            // ignore
          }
        }
      }
      return result;
    };
    root.execute = wrappedExecute;

    registerHook({
      name: hookName,
      target: root,
      methodName: 'execute',
      original: rawExecute,
      wrapped: wrappedExecute,
      onUnwrap() {
        root.execute = rawExecute;
        delete root.__stateScopeAfterBizWrapped;
      }
    });

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

export function resetBootstrapState() {
  bootstrapAttempt = 0;
  bootstrapComplete = false;
}

export function getBootstrapStatus() {
  return {
    attempt: bootstrapAttempt,
    complete: bootstrapComplete,
    maxAttempts: BOOTSTRAP_RETRY_DELAYS.length + 1
  };
}

export { wrapGetDisable as wrapGetDisableLegacy };
