/**
 * 运行时识别：boName 来自 bizApplication / presenter / viewModel，profile 见 profile-registry。
 */

import { resolveBoNameFromRoute, resolveBoNameFromViewModel } from './discover.js';
import { resolveEffectiveProfile, resolveProfileDetection } from './profile-registry.js';

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
  return `${window.location.pathname}${window.location.hash || ''}${window.location.search || ''}`;
}

function resolveMetaBoName(context = {}) {
  return (
    context.boName ||
    getBoName(context.bizApplication) ||
    context.presenter?.voucherBoName ||
    context.presenter?.boName ||
    context.formController?.presenter?.voucherBoName ||
    resolveBoNameFromViewModel(context.viewModel) ||
    resolveBoNameFromRoute() ||
    ''
  );
}

export function detectProfile(context = {}) {
  const boName = resolveMetaBoName(context);
  return resolveEffectiveProfile(context, boName).effectiveProfile;
}

export function getProfileDetection(context = {}) {
  const boName = resolveMetaBoName(context);
  return resolveEffectiveProfile(context, boName);
}

export function getRuntimeMeta(context = {}) {
  const bizApplication = context.bizApplication || window.bizApplication;
  const boName = resolveMetaBoName({ ...context, bizApplication });
  const profileDetection = getProfileDetection({ ...context, bizApplication, boName });

  return {
    boName,
    action: getAction(bizApplication, context.presenter),
    route: getRouteHint(),
    profile: profileDetection.effectiveProfile,
    profileDetection
  };
}
