const LOG_PREFIX = '[StateScope]';

import { discoverLowcodeCard, discoverLowcodeInterlayer, discoverMdfBizApplication, resolveLowcodeUiRoot } from './wrap-lowcode.js';

export function isBizDebugEnabled() {
  try {
    if (window.bizDebug === true) {
      return true;
    }
    return localStorage.getItem('bizDebug') === 'true';
  } catch {
    return false;
  }
}

export function getActivationDiagnostics(context = {}) {
  const bizApplication = context.bizApplication;
  const profileDetection = context.profileDetection || null;
  const viewModel = context.viewModel;
  const card = discoverLowcodeCard(viewModel);
  const mdfBiz = discoverMdfBizApplication(viewModel);
  const interlayer = discoverLowcodeInterlayer(viewModel, mdfBiz);
  const uiRoot = resolveLowcodeUiRoot(viewModel, mdfBiz);
  const mdfApp = typeof window !== 'undefined' ? window.mdf : null;
  return {
    bizDebug: isBizDebugEnabled(),
    windowBizApplication: !!window.bizApplication,
    stateManager: !!bizApplication?.stateManager,
    presenter: !!context.presenter,
    uiStateController: !!context.uiStateController,
    formController: !!context.formController,
    lowcodeViewModel: !!viewModel,
    lowcodeCard: !!card,
    mdfAppManager: !!mdfApp,
    mdfCur: !!mdfApp?.cur,
    mdfDoDispatch: typeof mdfBiz?.doDispatch === 'function',
    mdfBizApplication: !!mdfBiz,
    mdfInterlayer: !!interlayer,
    mdfUiRoot: !!uiRoot,
    mdfSyncChangedFields: typeof interlayer?.syncChangedFields === 'function',
    mdfGetDisableHook: !!uiRoot?.__stateScopeUiReaderHooked,
    mdfAfterBizActionHook: !!uiRoot?.__stateScopeAfterBizWrapped,
    mdfStateManager: !!mdfBiz?.stateManager,
    mdfStateRecomputeHook: !!mdfBiz?.stateManager?.__stateScopeRecomputeWrapped,
    mdfApplyStateAfterDataSync: typeof mdfBiz?.applyStateAfterDataSync === 'function',
    boName: context.boName || bizApplication?.boName || context.presenter?.voucherBoName || '',
    profile: context.profile || profileDetection?.effectiveProfile || 'unknown',
    profileDetection
  };
}

export function canActivate(context = {}) {
  if (!isBizDebugEnabled()) {
    return false;
  }

  return !!(
    context.bizApplication?.stateManager ||
    context.uiStateController ||
    context.formController ||
    context.presenter ||
    context.viewModel ||
    // 低代码：路由已解析 boName（viewModel 可能尚未挂载）
    (context.boName && (context.profile === 'lowcode' || context.profileDetection?.effectiveProfile === 'lowcode'))
  );
}

export function isRuntimeReady(context = {}) {
  if (!canActivate(context)) {
    return false;
  }

  const profile = context.profile || inferProfile(context);

  if (profile === 'traditional') {
    return !!(context.uiStateController || context.formController || context.presenter);
  }

  if (profile === 'lowcode') {
    // 路由已识别 boName 时允许先激活 API；hook 等 viewModel 就绪后再装
    return !!(context.viewModel || context.boName);
  }

  return !!context.bizApplication?.stateManager;
}

function inferProfile(context) {
  if (context.viewModel || context.profile === 'lowcode') {
    return 'lowcode';
  }
  if (context.uiStateController || context.formController || context.presenter) {
    return 'traditional';
  }
  return 'unknown';
}

export function warnIfNonLocalhostActive() {
  try {
    const { hostname } = window.location;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.endsWith('.local')) {
      console.warn(`${LOG_PREFIX} bizDebug=true on non-local host (${hostname}). Do not use in production.`);
    }
  } catch {
    // ignore
  }
}

export { LOG_PREFIX };
