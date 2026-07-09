/**
 * BO 默认 Profile 与运行时探测（方案：Profile 与 boName 正交）。
 */

import { isLowcodeViewModel } from './discover.js';

/** 治理映射：新 BO 接入时在此或 allowlist 元数据扩展 */
export const BO_PROFILE_DEFAULTS = {
  GoodsIssue: 'traditional',
  SalesOrder: 'traditional',
  OutsourceIssue: 'lowcode',
  OutsourceStockin: 'lowcode',
  MpManufactureOrder: 'lowcode'
};

export function getForcedProfileMode() {
  try {
    const raw = localStorage.getItem('stateScopeProfile');
    if (raw === 'traditional' || raw === 'lowcode') {
      return raw;
    }
  } catch {
    // ignore
  }
  return 'auto';
}

export function setForcedProfileMode(mode) {
  const value = mode === 'traditional' || mode === 'lowcode' ? mode : 'auto';
  localStorage.setItem('stateScopeProfile', value);
  return value;
}

function collectSignals(context = {}) {
  const { uiStateController, formController, presenter, viewModel, bizApplication } = context;
  const traditional = !!(
    uiStateController ||
    formController ||
    (presenter?.controllers?.uiStateController && presenter?.controllers?.formController)
  );
  const lowcode = isLowcodeViewModel(viewModel);
  const stateManager = !!bizApplication?.stateManager;

  return { traditional, lowcode, stateManager };
}

function inferAutoProfile(signals, boName) {
  if (signals.traditional && signals.lowcode) {
    return 'hybrid';
  }
  if (signals.traditional) {
    return 'traditional';
  }
  if (signals.lowcode) {
    return 'lowcode';
  }
  if (boName && BO_PROFILE_DEFAULTS[boName]) {
    return BO_PROFILE_DEFAULTS[boName];
  }
  if (signals.stateManager) {
    return 'traditional';
  }
  return 'unknown';
}

function buildReason(mode, profile, signals, boName) {
  if (mode === 'forced') {
    return `手动强制 profile=${profile}`;
  }
  if (profile === 'hybrid') {
    return '同时检测到 FormController/StateCollector 与 MDF viewModel，请选手动 Profile';
  }
  if (signals.traditional && profile === 'traditional') {
    return '检测到 presenter / formController / uiStateController';
  }
  if (signals.lowcode && profile === 'lowcode') {
    return '检测到 MDF viewModel.getDisable';
  }
  if (boName && BO_PROFILE_DEFAULTS[boName] && profile === BO_PROFILE_DEFAULTS[boName]) {
    return `boName=${boName} 映射默认 profile`;
  }
  if (signals.stateManager) {
    return '仅有 stateManager，按传统链路处理';
  }
  return '未识别运行时形态';
}

function resolveConfidence(profile, signals, mode) {
  if (mode === 'forced') {
    return 'high';
  }
  if (profile === 'hybrid') {
    return 'low';
  }
  if (profile === 'unknown') {
    return 'low';
  }
  if (profile === 'traditional' && signals.traditional) {
    return 'high';
  }
  if (profile === 'lowcode' && signals.lowcode) {
    return 'high';
  }
  if (BO_PROFILE_DEFAULTS[profile]) {
    return 'medium';
  }
  return 'medium';
}

/**
 * @returns {{ profile, mode, confidence, reason, signals, boDefault }}
 */
export function resolveProfileDetection(context = {}, boName = '') {
  const mode = getForcedProfileMode();
  const signals = collectSignals(context);
  const boDefault = boName ? BO_PROFILE_DEFAULTS[boName] || null : null;

  let profile;
  if (mode === 'traditional' || mode === 'lowcode') {
    profile = mode;
  } else {
    profile = inferAutoProfile(signals, boName);
  }

  const confidence = resolveConfidence(profile, signals, mode === 'auto' ? 'auto' : 'forced');
  const reason = buildReason(mode === 'auto' ? 'auto' : 'forced', profile, signals, boName);

  return {
    profile,
    mode: mode === 'auto' ? 'auto' : 'forced',
    confidence,
    reason,
    signals,
    boDefault
  };
}

/** installHooks 用：hybrid/unknown 时按 forced 或 bo 默认择 effective profile */
export function resolveEffectiveProfile(context = {}, boName = '') {
  const detection = resolveProfileDetection(context, boName);
  if (detection.profile === 'hybrid' || detection.profile === 'unknown') {
    if (detection.boDefault) {
      return { ...detection, effectiveProfile: detection.boDefault };
    }
    if (detection.signals.traditional) {
      return { ...detection, effectiveProfile: 'traditional' };
    }
    if (detection.signals.lowcode) {
      return { ...detection, effectiveProfile: 'lowcode' };
    }
    return { ...detection, effectiveProfile: 'unknown' };
  }
  return { ...detection, effectiveProfile: detection.profile };
}
