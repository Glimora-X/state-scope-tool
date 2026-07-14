import { valuesEqual } from './normalize.js';
import { isSnapKeyInAllowlistSet } from './allowlist-config.js';

const SEVERITY = {
  OK: 'ok',
  LOGIC_MISMATCH: 'logic-mismatch',
  LEGACY_ONLY: 'legacy-only',
  NEW_ONLY: 'new-only'
};

/**
 * 对比两份快照并输出逐字段差异。
 *
 * 调用方传入的实际内容因 profile 而异：
 * - traditional：oldSnap = 操作前状态，newSnap = 升级后链路终态
 * - lowcode：oldSnap = 可见态（finalSnap / visibleSnap），newSnap = 影子态（shadowSnap）
 *
 * 本函数不感知 profile，仅做纯数据比对。
 */
export function diffSnapshots(oldSnap, newSnap, allowlist) {
  const keys = new Set([...Object.keys(oldSnap || {}), ...Object.keys(newSnap || {})]);
  const diffs = [];

  for (const key of keys) {
    if (allowlist?.size && !isSnapKeyInAllowlistSet(key, allowlist)) {
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
