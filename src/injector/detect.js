/**
 * 运行时识别：boName 来自 bizApplication / presenter，profile 优先 traditional。
 */

import { isLowcodeViewModel } from './discover.js';

export function getBoName(bizApplication) {
  if (!bizApplication) {
    return '';
  }
  return (
    bizApplication.boName ||
    bizApplication.options?.boName ||
    bizApplication.bizSchemaManager?.boName ||
    ''
  );
}

export function getAction(bizApplication, presenter) {
  return (
    bizApplication?.options?.action ||
    presenter?.options?.action ||
    presenter?.controllers?.stateController?.voucherState?.action ||
    'unknown'
  );
}

export function getRouteHint() {
  return `${window.location.pathname}${window.location.search}`;
}

export function detectProfile(context = {}) {
  const forced = localStorage.getItem('stateScopeProfile');
  if (forced === 'traditional' || forced === 'lowcode') {
    return forced;
  }

  const { uiStateController, formController, presenter, viewModel } = context;

  if (uiStateController || formController || presenter) {
    return 'traditional';
  }

  if (isLowcodeViewModel(viewModel)) {
    return 'lowcode';
  }

  return 'unknown';
}

export function getRuntimeMeta(context = {}) {
  const bizApplication = context.bizApplication || window.bizApplication;
  return {
    boName: context.boName || getBoName(bizApplication),
    action: getAction(bizApplication, context.presenter),
    route: getRouteHint(),
    profile: detectProfile(context)
  };
}
