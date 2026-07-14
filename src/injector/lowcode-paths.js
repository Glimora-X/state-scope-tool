/**
 * 低代码状态 path 归一化（对齐 allowlist fieldPathForUuid）。
 */

export function buildLowcodeMainPath(fieldName, stateType = 'disabled') {
  return `main.${fieldName}.${stateType}`;
}

/**
 * allowlist path `main.currencyId` → main 容器下的 fieldModel（兼容扁平 root.get(field)）。
 */
export function resolveMainFieldModel(viewModel, fieldPath) {
  if (!viewModel || !fieldPath?.startsWith('main.')) {
    return null;
  }
  const fieldName = fieldPath.slice('main.'.length);
  const root = viewModel?.root || viewModel;
  try {
    const main = root.get?.('main');
    if (main && typeof main.get === 'function') {
      const viaMain = main.get(fieldName);
      if (viaMain) {
        return viaMain;
      }
    }
    return root.get?.(fieldName) || null;
  } catch {
    return null;
  }
}

export function buildLowcodeDetailPath(bodyName, rowKey, fieldName, stateType = 'disabled') {
  const body = bodyName || 'detailList';
  const row = rowKey == null || rowKey === undefined ? '0' : String(rowKey);
  return `${body}.${row}.${fieldName}.${stateType}`;
}

/**
 * getDisable(name, index, grid) → snap key。
 * 明细行优先 uuid（与 shadowStore / biz-core 一致），避免 detailList.0 vs detailList.{uuid} 双条。
 */
export function buildLowcodePathFromGetDisable(name, index, obj, stateType = 'disabled') {
  if (index == null || index === undefined) {
    return buildLowcodeMainPath(name, stateType);
  }
  const bodyName =
    obj?.name || obj?.get?.('name') || obj?.bodyName || obj?.tableName || 'detailList';
  let rowKey = index;
  try {
    const rowData =
      (Array.isArray(obj?.data) ? obj.data[index] : null) ||
      (typeof obj?.getRow === 'function' ? obj.getRow(index) : null) ||
      (typeof obj?.getRowItem === 'function' ? obj.getRowItem(index)?.data || obj.getRowItem(index) : null);
    if (rowData && typeof rowData === 'object') {
      rowKey = resolveRowKeyFromModel(
        {
          get: (k) => rowData[k],
          uuid: rowData.uuid,
          rowUuid: rowData.rowUuid,
          id: rowData.id
        },
        index
      );
    }
  } catch {
    // keep index
  }
  return buildLowcodeDetailPath(bodyName, rowKey, name, stateType);
}

export function resolveRowKeyFromModel(model, fallbackIndex) {
  if (!model) {
    return fallbackIndex == null ? '0' : String(fallbackIndex);
  }
  try {
    const uuid =
      model.get?.('uuid') ??
      model.get?.('rowUuid') ??
      model.get?.('id') ??
      model.uuid ??
      model.rowUuid;
    if (uuid != null && uuid !== '') {
      return String(uuid);
    }
  } catch {
    // ignore
  }
  return fallbackIndex == null ? '0' : String(fallbackIndex);
}
