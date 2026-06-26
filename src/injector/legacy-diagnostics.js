import { buildOldPath, normalizeOldFieldState } from './normalize.js';
import { filterTopLevelEntries } from './path-filter.js';

let pendingScope = null;

function countDistinctMainRoots(mainList = []) {
  const roots = new Set();
  for (const name of mainList) {
    if (!name) {
      continue;
    }
    roots.add(String(name).split('.')[0]);
  }
  return roots.size;
}

export function resolveMainFieldsArray(presenter, formController) {
  return (
    formController?.model?.main?.fieldsArray ||
    presenter?.voucherModel?.main?.fieldsArray ||
    presenter?.model?.main?.fieldsArray ||
    []
  );
}

export function summarizeChangeScope(changeData, presenter, formController) {
  const scope = {
    mainInChangedSet: 0,
    detailBodies: {},
    detailRowsInChangedSet: 0,
    detailRecalcRows: 0,
    mainRecalcCount: 0
  };

  if (!changeData) {
    return scope;
  }

  scope.mainInChangedSet = countDistinctMainRoots(changeData.main);

  if (changeData.body) {
    for (const [bodyName, bodyChange] of Object.entries(changeData.body)) {
      const insert = bodyChange?.insertUuids?.length || 0;
      const update = bodyChange?.updateUuids?.length || 0;
      const deleteCount = bodyChange?.deleteUuids?.length || 0;
      if (insert || update || deleteCount) {
        scope.detailBodies[bodyName] = { insert, update, delete: deleteCount };
      }
      scope.detailRowsInChangedSet += insert + update;
    }
  }

  if ((changeData.main?.length || 0) > 0) {
    scope.mainRecalcCount = resolveMainFieldsArray(presenter, formController).filter(
      (field) => !field.isCarryField && !field.isContextField
    ).length;
  }

  return scope;
}

export function mergeScope(hookedScope, derivedScope) {
  if (!hookedScope && !derivedScope) {
    return null;
  }

  return {
    ...(derivedScope || {}),
    ...(hookedScope || {}),
    mainInChangedSet: hookedScope?.mainInChangedSet ?? derivedScope?.mainInChangedSet ?? 0,
    detailRowsInChangedSet: hookedScope?.detailRowsInChangedSet ?? derivedScope?.detailRowsInChangedSet ?? 0,
    detailRecalcRows: hookedScope?.detailRecalcRows ?? derivedScope?.detailRecalcRows ?? 0,
    mainRecalcCount: hookedScope?.mainRecalcCount || derivedScope?.mainRecalcCount || 0,
    detailBodies: {
      ...(derivedScope?.detailBodies || {}),
      ...(hookedScope?.detailBodies || {})
    }
  };
}

export function installLegacyDiagnostics(uiState, presenter, formController) {
  if (!uiState || uiState.__stateScopeDiagInstalled__) {
    return;
  }

  uiState.__stateScopeDiagInstalled__ = true;

  const mainCollector = uiState.stateCollectors?.main;
  if (mainCollector && typeof mainCollector.checkMainFieldState === 'function') {
    const originalMainCheck = mainCollector.checkMainFieldState.bind(mainCollector);
    mainCollector.checkMainFieldState = function checkMainFieldStateWrapped() {
      const fieldCount =
        mainCollector.voucherModel?.main?.fieldsArray?.filter(
          (field) => !field.isCarryField && !field.isContextField
        ).length ||
        presenter?.voucherModel?.main?.fieldsArray?.filter(
          (field) => !field.isCarryField && !field.isContextField
        ).length ||
        resolveMainFieldsArray(presenter, formController).filter(
          (field) => !field.isCarryField && !field.isContextField
        ).length ||
        0;

      if (pendingScope) {
        pendingScope.mainRecalcCount = fieldCount;
      }

      return originalMainCheck();
    };
  }

  for (const detailName of uiState.details || Object.keys(uiState.stateCollectors || {})) {
    const collector = uiState.stateCollectors?.[detailName];
    if (!collector || typeof collector.checkChangeStates !== 'function' || collector.__stateScopeDetailDiag__) {
      continue;
    }

    collector.__stateScopeDetailDiag__ = true;
    const originalDetailCheck = collector.checkChangeStates.bind(collector);
    collector.checkChangeStates = function detailCheckChangeStatesWrapped(rowUuids) {
      if (pendingScope && Array.isArray(rowUuids)) {
        pendingScope.detailRecalcRows = (pendingScope.detailRecalcRows || 0) + rowUuids.length;
      }
      return originalDetailCheck(rowUuids);
    };
  }

  if (typeof uiState.checkChangeStates === 'function') {
    const originalCheck = uiState.checkChangeStates.bind(uiState);
    uiState.checkChangeStates = function checkChangeStatesWrapped(changeData) {
      pendingScope = summarizeChangeScope(changeData, presenter, formController);
      return originalCheck(changeData);
    };
  }
}

export function takeScopeDiagnostics() {
  const scope = pendingScope;
  pendingScope = null;
  return scope;
}

export function collectMainFinalStates(uiState, presenter, formController) {
  const fields = resolveMainFieldsArray(presenter, formController);
  const entries = {};

  for (const field of fields) {
    if (field.isCarryField || field.isContextField) {
      continue;
    }

    const fieldName = field.fieldName;
    if (!fieldName || String(fieldName).includes('.')) {
      continue;
    }

    const result = uiState.getMainFieldState(fieldName);
    const normalized = normalizeOldFieldState(result);
    for (const [stateType, value] of Object.entries(normalized)) {
      entries[`main.${fieldName}.${stateType}`] = value;
    }
  }

  return filterTopLevelEntries(entries);
}

export function collectDetailFinalStates(uiState, changeData) {
  const entries = {};

  if (!changeData?.body) {
    return entries;
  }

  for (const [detailName, bodyChange] of Object.entries(changeData.body)) {
    const rowRefs = [...(bodyChange?.insertUuids || []), ...(bodyChange?.updateUuids || [])];

    for (const rowRef of rowRefs) {
      const uuid = typeof rowRef === 'string' ? rowRef : rowRef?.uuid;
      if (!uuid || uuid === 'undefined') {
        continue;
      }

      const rowState = uiState.getRowState?.(detailName, uuid);
      if (!rowState || typeof rowState !== 'object') {
        continue;
      }

      for (const [fieldName, result] of Object.entries(rowState)) {
        if (String(fieldName).includes('.')) {
          continue;
        }
        const normalized = normalizeOldFieldState(result);
        for (const [stateType, value] of Object.entries(normalized)) {
          entries[`${buildOldPath(detailName, uuid, fieldName)}.${stateType}`] = value;
        }
      }
    }
  }

  return filterTopLevelEntries(entries);
}

export function formatScopeLine(scope) {
  if (!scope) {
    return null;
  }

  const parts = [];

  if (scope.mainInChangedSet > 0 || scope.mainRecalcCount > 0) {
    parts.push(
      `changedFields.main=${scope.mainInChangedSet} → checkMainFieldState 重算 ${scope.mainRecalcCount || '?'} 个表头字段`
    );
  }

  if (scope.detailRowsInChangedSet > 0 || scope.detailRecalcRows > 0) {
    const bodySummary = Object.entries(scope.detailBodies || {})
      .map(([name, stat]) => `${name}(+${stat.insert}/~${stat.update}/-${stat.delete})`)
      .join(', ');
    const changed = scope.detailRowsInChangedSet || 0;
    const recalc = scope.detailRecalcRows || changed || '?';
    parts.push(
      `明细变更行 ${changed} → checkChangeStates 重算 ${recalc} 行${bodySummary ? ` [${bodySummary}]` : ''}`
    );
  }

  return parts.length ? parts.join(' | ') : 'scope 未识别到 main/body 变更';
}

export function formatGroupTitle(scope, changedSample, finalSnap) {
  const scopeLine = formatScopeLine(scope);
  const sampleCount = Object.keys(changedSample || {}).length;
  const finalCount = Object.keys(finalSnap || {}).length;
  return `${scopeLine} · 变更集${sampleCount}条/快照${finalCount}条`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDetailStateKey(key) {
  const parts = key.split('.');
  const stateType = parts[parts.length - 1];
  if (parts.length < 4 || parts[0] === 'main') {
    return null;
  }
  if (stateType !== 'visible' && stateType !== 'disabled') {
    return null;
  }
  return { body: parts[0], rowKey: parts[1] };
}

export function classifyDetailRowKey(rowKey) {
  if (!rowKey || rowKey === 'undefined') {
    return 'invalid';
  }
  if (/^\d+$/.test(rowKey)) {
    return 'grid-index';
  }
  if (UUID_RE.test(rowKey)) {
    return 'uuid';
  }
  return 'opaque';
}

/**
 * 从快照 key 提取各子表行的 rowKey 类型（grid 行号 vs uuid）。
 */
export function analyzeDetailPathHints(...snaps) {
  const byBody = new Map();

  for (const snap of snaps) {
    if (!snap) {
      continue;
    }
    for (const key of Object.keys(snap)) {
      const parsed = parseDetailStateKey(key);
      if (!parsed) {
        continue;
      }
      if (!byBody.has(parsed.body)) {
        byBody.set(parsed.body, new Map());
      }
      const rows = byBody.get(parsed.body);
      if (!rows.has(parsed.rowKey)) {
        rows.set(parsed.rowKey, classifyDetailRowKey(parsed.rowKey));
      }
    }
  }

  return byBody;
}

function formatRowKeyLabel(rowKey, kind) {
  if (kind === 'grid-index') {
    return `rowKey=${rowKey} (grid行号, 非uuid)`;
  }
  if (kind === 'uuid') {
    const short = rowKey.length > 12 ? `${rowKey.slice(0, 8)}…` : rowKey;
    return `rowKey=${short} (uuid)`;
  }
  if (kind === 'invalid') {
    return `rowKey=${rowKey} (无效)`;
  }
  return `rowKey=${rowKey} (opaque)`;
}

export function formatDetailPathHint(...snaps) {
  const byBody = analyzeDetailPathHints(...snaps);
  if (byBody.size === 0) {
    return null;
  }

  const parts = [];
  for (const [body, rows] of byBody) {
    for (const [rowKey, kind] of rows) {
      parts.push(`${body}.${formatRowKeyLabel(rowKey, kind)}`);
    }
  }
  return parts.join('; ');
}

export function formatDetailPathHintForDiagnose(...snaps) {
  const byBody = analyzeDetailPathHints(...snaps);
  if (byBody.size === 0) {
    return [];
  }

  const rows = [];
  for (const [body, rowMap] of byBody) {
    for (const [rowKey, kind] of rowMap) {
      rows.push({ body, rowKey, kind, label: formatRowKeyLabel(rowKey, kind) });
    }
  }
  return rows;
}
