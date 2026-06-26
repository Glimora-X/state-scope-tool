/**
 * 路径过滤：只保留表头/子表顶层字段，跳过 refer 展开字段（如 main.soldToCustId.partyName）。
 */
export function isTopLevelStatePath(path) {
  const parts = path.split('.');
  const stateType = parts[parts.length - 1];
  if (stateType !== 'visible' && stateType !== 'disabled') {
    return false;
  }

  if (parts[0] === 'main' && parts.length === 3) {
    return true;
  }

  if (parts[0] !== 'main' && parts.length === 4) {
    const rowKey = parts[1];
    if (!rowKey || rowKey === 'undefined') {
      return false;
    }
    return true;
  }

  return false;
}

export function filterTopLevelEntries(entries = {}) {
  const filtered = {};
  for (const [key, value] of Object.entries(entries)) {
    if (isTopLevelStatePath(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function isVerboseMode() {
  try {
    return localStorage.getItem('stateScopeVerbose') === 'true';
  } catch {
    return false;
  }
}
