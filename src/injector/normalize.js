const STATE_TYPES = ['visible', 'disabled'];

import { filterTopLevelEntries } from './path-filter.js';

export function normalizeOldFieldState(result) {
  const normalized = {};
  if (!result || typeof result !== 'object') {
    return normalized;
  }

  if (typeof result.disable === 'boolean') {
    normalized.disabled = result.disable;
  }
  if (typeof result.editable === 'boolean') {
    normalized.disabled = !result.editable;
  }
  if (typeof result.visible === 'boolean') {
    normalized.visible = result.visible;
  }

  return normalized;
}

export function buildOldPath(detailName, uuid, fieldName) {
  if (detailName === 'main' || uuid === 'main') {
    return `main.${fieldName}`;
  }
  return `${detailName}.${uuid}.${fieldName}`;
}

export function flattenStatePatches(patches, prefix = '') {
  const flat = {};
  if (!patches || typeof patches !== 'object') {
    return flat;
  }

  if (patches.__properties__ && typeof patches.__properties__ === 'object') {
    for (const stateType of STATE_TYPES) {
      const item = patches.__properties__[stateType];
      if (item && typeof item.value === 'boolean') {
        flat[`${prefix}.${stateType}`] = item.value;
      }
    }
    return flat;
  }

  for (const [key, value] of Object.entries(patches)) {
    if (value == null || typeof value !== 'object') {
      continue;
    }
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    Object.assign(flat, flattenStatePatches(value, nextPrefix));
  }

  return flat;
}

/**
 * biz-core statePatches 表头路径无 main. 前缀（exchangeRate.disabled），
 * 与 old 轨 main.exchangeRate.disabled 对齐后再做 top-level 过滤。
 */
export function normalizeNewSnapKey(key) {
  const parts = String(key).split('.');
  const stateType = parts[parts.length - 1];
  if (stateType !== 'visible' && stateType !== 'disabled') {
    return key;
  }
  if (parts[0] === 'main' && parts.length === 3) {
    return key;
  }
  if (parts[0] !== 'main' && parts.length === 4) {
    return key;
  }
  if (parts.length === 2) {
    return `main.${key}`;
  }
  return key;
}

export function normalizeNewSnapPaths(flat) {
  const normalized = {};
  for (const [key, value] of Object.entries(flat || {})) {
    normalized[normalizeNewSnapKey(key)] = value;
  }
  return normalized;
}

export function captureStatePatchesAsSnap(statePatches) {
  return filterTopLevelEntries(normalizeNewSnapPaths(flattenStatePatches(statePatches)));
}

export function mergeSnapshot(target, source) {
  return Object.assign(target, source);
}

export function valuesEqual(a, b) {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return a === b;
}
