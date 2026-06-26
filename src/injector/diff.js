import { valuesEqual } from './normalize.js';

const SEVERITY = {
  OK: 'ok',
  LOGIC_MISMATCH: 'logic-mismatch',
  LEGACY_ONLY: 'legacy-only',
  NEW_ONLY: 'new-only'
};

export function diffSnapshots(oldSnap, newSnap, allowlist) {
  const keys = new Set([...Object.keys(oldSnap || {}), ...Object.keys(newSnap || {})]);
  const diffs = [];

  for (const key of keys) {
    if (allowlist?.size && !allowlist.has(stripStateSuffix(key))) {
      continue;
    }

    const oldVal = oldSnap?.[key];
    const newVal = newSnap?.[key];

    let severity = SEVERITY.OK;
    if (oldVal !== undefined && newVal !== undefined && !valuesEqual(oldVal, newVal)) {
      severity = SEVERITY.LOGIC_MISMATCH;
    } else if (oldVal !== undefined && newVal === undefined) {
      severity = SEVERITY.LEGACY_ONLY;
    } else if (oldVal === undefined && newVal !== undefined) {
      severity = SEVERITY.NEW_ONLY;
    }

    diffs.push({
      path: key,
      old: oldVal,
      new: newVal,
      severity
    });
  }

  return diffs;
}

function stripStateSuffix(path) {
  return path.replace(/\.(visible|disabled)$/, '');
}

export { SEVERITY };
