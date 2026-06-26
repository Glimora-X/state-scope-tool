const LOG_PREFIX = '[StateScope]';

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
  return {
    bizDebug: isBizDebugEnabled(),
    windowBizApplication: !!window.bizApplication,
    stateManager: !!bizApplication?.stateManager,
    presenter: !!context.presenter,
    uiStateController: !!context.uiStateController,
    formController: !!context.formController,
    lowcodeViewModel: !!context.viewModel,
    boName: context.boName || bizApplication?.boName || context.presenter?.voucherBoName || ''
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
    context.viewModel
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
    return !!context.viewModel;
  }

  return !!context.bizApplication?.stateManager;
}

function inferProfile(context) {
  if (context.uiStateController || context.formController || context.presenter) {
    return 'traditional';
  }
  if (context.viewModel) {
    return 'lowcode';
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
