/**
 * 低代码 epoch 暂存缓冲区
 *
 * 三个 buffer 与 epoch 字段的对应关系：
 *   pendingOld    → epoch.oldSnap     (lowcode: 可见态 visibleSnap)
 *   pendingFinal  → epoch.finalSnap   (lowcode: 可见态 visibleSnap，与 old 相同)
 *   pendingShadow → epoch.shadowSnap  (lowcode: 影子态，shadowStore 终态)
 *
 * lowcode 模式下 pendingOld 和 pendingFinal 被写入相同的 visibleSnap，
 * 实际 Diff 轴为 finalSnap（可见态）vs shadowSnap（影子态）。
 */
import { captureStatePatchesAsSnap } from './normalize.js';
import { flattenShadowStore } from './lowcode-shadow.js';

let currentSessionToken = '';
let pendingOld = {};
let pendingFinal = {};
let pendingShadow = {};

export function resetSession(newToken) {
  currentSessionToken = newToken || '';
  pendingOld = {};
  pendingFinal = {};
  pendingShadow = {};
}

export function getSessionToken() {
  return currentSessionToken;
}

function isSessionValid(sessionToken) {
  if (!sessionToken || !currentSessionToken) {
    return true;
  }
  return sessionToken === currentSessionToken;
}

export function bufferLowcodeOld(entries, sessionToken) {
  if (!isSessionValid(sessionToken)) return;
  if (entries) {
    Object.assign(pendingOld, entries);
  }
}

export function bufferLowcodeFinal(entries, sessionToken) {
  if (!isSessionValid(sessionToken)) return;
  if (entries) {
    Object.assign(pendingFinal, entries);
  }
}

export function bufferLowcodeShadow(entries, sessionToken) {
  if (!isSessionValid(sessionToken)) return;
  if (entries) {
    Object.assign(pendingShadow, entries);
  }
}

export function bufferLowcodeShadowFromPatches(statePatches, mode = 'shadow', sessionToken) {
  if (!statePatches || mode !== 'shadow') {
    return;
  }
  bufferLowcodeShadow(captureStatePatchesAsSnap(statePatches), sessionToken);
}

export function bufferLowcodeShadowFromStore(viewModel, bizApp, allowlistConfig, sessionToken) {
  bufferLowcodeShadow(flattenShadowStore(viewModel, bizApp, allowlistConfig), sessionToken);
}

export function peekLowcodePending() {
  return {
    old: { ...pendingOld },
    final: { ...pendingFinal },
    shadow: { ...pendingShadow }
  };
}

export function takeLowcodePending() {
  const snap = {
    old: pendingOld,
    final: pendingFinal,
    shadow: pendingShadow
  };
  pendingOld = {};
  pendingFinal = {};
  pendingShadow = {};
  return snap;
}

export function mergeLowcodeBufferIntoEpoch(epoch) {
  if (!epoch) {
    return;
  }
  const pending = takeLowcodePending();
  if (!epoch.oldSnap) {
    epoch.oldSnap = {};
  }
  if (!epoch.finalSnap) {
    epoch.finalSnap = {};
  }
  if (!epoch.shadowSnap) {
    epoch.shadowSnap = {};
  }
  Object.assign(epoch.oldSnap, pending.old);
  Object.assign(epoch.finalSnap, pending.final);
  Object.assign(epoch.shadowSnap, pending.shadow);
}
