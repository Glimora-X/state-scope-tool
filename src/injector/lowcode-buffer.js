import { captureStatePatchesAsSnap } from './normalize.js';
import { flattenShadowStore } from './lowcode-shadow.js';

let pendingOld = {};
let pendingFinal = {};
let pendingShadow = {};

export function bufferLowcodeOld(entries) {
  if (entries) {
    Object.assign(pendingOld, entries);
  }
}

export function bufferLowcodeFinal(entries) {
  if (entries) {
    Object.assign(pendingFinal, entries);
  }
}

export function bufferLowcodeShadow(entries) {
  if (entries) {
    Object.assign(pendingShadow, entries);
  }
}

export function bufferLowcodeShadowFromPatches(statePatches, mode = 'shadow') {
  if (!statePatches || mode !== 'shadow') {
    return;
  }
  bufferLowcodeShadow(captureStatePatchesAsSnap(statePatches));
}

export function bufferLowcodeShadowFromStore(viewModel, bizApp, allowlistConfig) {
  bufferLowcodeShadow(flattenShadowStore(viewModel, bizApp, allowlistConfig));
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
