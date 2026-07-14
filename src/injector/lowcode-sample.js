/**
 * 低代码 allowlist 主动采样：表头 + 明细 {uuid} 字段。
 * 升级前 finalSnap 依赖本模块，避免仅依赖 getDisable 偶发读路径。
 */

import {
  buildLowcodeDetailPath,
  buildLowcodeMainPath,
  resolveMainFieldModel,
  resolveRowKeyFromModel
} from './lowcode-paths.js';

export const LOWCODE_STATE_TYPES = ['visible', 'disabled'];

/** allowlist `detailList.{uuid}.warehouseId` → { bodyName, fieldName } */
export function parseAllowlistDetailPath(path) {
  if (!path || typeof path !== 'string' || !path.includes('{uuid}')) {
    return null;
  }
  const parts = path.split('.');
  if (parts.length < 3 || parts[1] !== '{uuid}') {
    return null;
  }
  return {
    bodyName: parts[0],
    fieldName: parts.slice(2).join('.')
  };
}

function readModelStateType(model, stateType) {
  if (!model || typeof model.get !== 'function') {
    return undefined;
  }
  try {
    const value = model.get(stateType);
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 解析 gridModel：优先 gridModels 按 name，其次 root.get(body) */
export function resolveGridModel(viewModel, bodyName) {
  const root = viewModel?.root || viewModel;
  if (!root || !bodyName) {
    return null;
  }
  try {
    const grids = root.gridModels;
    if (Array.isArray(grids)) {
      const hit = grids.find((g) => g?.name === bodyName || g?.get?.('name') === bodyName);
      if (hit) {
        return hit;
      }
    }
    const viaGet = root.get?.(bodyName);
    if (viaGet && (viaGet.data || viaGet.dataSource || typeof viaGet.getColumn === 'function')) {
      return viaGet;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 枚举行：[{ index, rowKey, rowData }]
 * rowKey 优先 uuid，与 shadowStore / biz-core fieldPathForUuid 对齐。
 */
export function listGridRows(gridModel) {
  const rows = [];
  if (!gridModel) {
    return rows;
  }
  const data = Array.isArray(gridModel.data)
    ? gridModel.data
    : Array.isArray(gridModel.dataSource)
      ? gridModel.dataSource.map((it) => it?.data || it)
      : [];

  for (let index = 0; index < data.length; index += 1) {
    const rowData = data[index];
    if (!rowData || typeof rowData !== 'object') {
      continue;
    }
    const rowKey = resolveRowKeyFromModel(
      {
        get: (k) => rowData[k],
        uuid: rowData.uuid,
        rowUuid: rowData.rowUuid,
        id: rowData.id
      },
      index
    );
    rows.push({ index, rowKey, rowData });
  }
  return rows;
}

/**
 * 读明细格子用户可见 disabled/visible。
 * 优先 column.get(stateType, { scope: { index }})（EditAble setDisabled 口径），
 * 再试 getRowStatus / 行字段 model。
 */
export function readDetailCellState(gridModel, fieldName, index, stateType) {
  if (!gridModel || !fieldName) {
    return undefined;
  }

  try {
    const column = gridModel.getColumn?.(fieldName);
    if (column && typeof column.get === 'function') {
      const viaCol = column.get(stateType, { scope: { index, name: fieldName } });
      if (typeof viaCol === 'boolean') {
        return viaCol;
      }
      // DeclarativeFunction 可能把 true 以外包装；再试无 scope
      const plain = column.get(stateType);
      if (typeof plain === 'boolean') {
        return plain;
      }
    }
  } catch {
    // ignore
  }

  try {
    if (typeof gridModel.getRowStatus === 'function') {
      const status = gridModel.getRowStatus(index, fieldName);
      if (typeof status === 'boolean') {
        return status;
      }
      if (status && typeof status === 'object' && typeof status[stateType] === 'boolean') {
        return status[stateType];
      }
      // status 可能直接是 disabled 布尔（历史缓存）
      if (stateType === 'disabled' && typeof status === 'boolean') {
        return status;
      }
    }
  } catch {
    // ignore
  }

  try {
    const rowItem = gridModel.getRowItem?.(index);
    const cell = rowItem?.get?.(fieldName) || rowItem?.[fieldName];
    const viaCell = readModelStateType(cell, stateType);
    if (typeof viaCell === 'boolean') {
      return viaCell;
    }
  } catch {
    // ignore
  }

  return undefined;
}

function sampleMainField(snap, viewModel, field, sampledMain) {
  const path = field.path;
  if (!path?.startsWith('main.') || path.includes('{uuid}')) {
    return;
  }

  const fieldName = path.slice('main.'.length);
  const model = resolveMainFieldModel(viewModel, path);
  if (!model) {
    return;
  }

  const primaryType = field.stateType || 'disabled';
  const typesToSample = sampledMain.has(fieldName) ? [primaryType] : LOWCODE_STATE_TYPES;

  for (const stateType of typesToSample) {
    const value = readModelStateType(model, stateType);
    if (typeof value === 'boolean') {
      snap[buildLowcodeMainPath(fieldName, stateType)] = value;
    }
  }
  sampledMain.add(fieldName);
}

function sampleDetailField(snap, viewModel, field) {
  const parsed = parseAllowlistDetailPath(field.path);
  if (!parsed) {
    return;
  }

  const gridModel = resolveGridModel(viewModel, parsed.bodyName);
  if (!gridModel) {
    return;
  }

  const primaryType = field.stateType || 'disabled';
  const rows = listGridRows(gridModel);
  const sampledKeys = new Set();

  for (const { index, rowKey } of rows) {
    const typesToSample =
      sampledKeys.has(`${rowKey}:${parsed.fieldName}`) ?
        [primaryType]
      : LOWCODE_STATE_TYPES;

    for (const stateType of typesToSample) {
      const value = readDetailCellState(gridModel, parsed.fieldName, index, stateType);
      if (typeof value === 'boolean') {
        snap[buildLowcodeDetailPath(parsed.bodyName, rowKey, parsed.fieldName, stateType)] =
          value;
      }
    }
    sampledKeys.add(`${rowKey}:${parsed.fieldName}`);
  }
}

/**
 * allowlist 主动采样（表头 + 明细）。
 * L2 仅对比字段状态（visible/disabled），不对比字段值。
 */
export function sampleAllowlistFieldStatesFromViewModel(viewModel, allowlistConfig, defaultFields) {
  if (!viewModel) {
    return {};
  }

  const snap = {};
  const fields = allowlistConfig?.fields?.length ?
      allowlistConfig.fields
    : defaultFields || [];
  const sampledMain = new Set();

  for (const field of fields) {
    if (!field?.path) {
      continue;
    }
    if (field.path.startsWith('main.') && !field.path.includes('{uuid}')) {
      sampleMainField(snap, viewModel, field, sampledMain);
      continue;
    }
    if (field.path.includes('{uuid}')) {
      sampleDetailField(snap, viewModel, field);
    }
  }

  return snap;
}

/**
 * 单行场景：index 键与 uuid 键合并到 uuid（若对侧仅有一端）。
 * 多行不猜测，避免错配。
 */
export function alignLowcodeDetailIndexUuidKeys(oldSnap, newSnap) {
  const outOld = { ...(oldSnap || {}) };
  const outNew = { ...(newSnap || {}) };

  const groupKey = (snapKey) => {
    const parts = String(snapKey).split('.');
    if (parts.length < 4 || parts[0] === 'main') {
      return null;
    }
    const stateType = parts[parts.length - 1];
    if (stateType !== 'visible' && stateType !== 'disabled') {
      return null;
    }
    const body = parts[0];
    const row = parts[1];
    const field = parts.slice(2, -1).join('.');
    const isIndex = /^\d+$/.test(row);
    return { group: `${body}..${field}.${stateType}`, body, row, field, stateType, isIndex, snapKey };
  };

  const collect = (snap) => {
    const map = new Map();
    for (const key of Object.keys(snap || {})) {
      const meta = groupKey(key);
      if (!meta) {
        continue;
      }
      if (!map.has(meta.group)) {
        map.set(meta.group, []);
      }
      map.get(meta.group).push(meta);
    }
    return map;
  };

  const oldGroups = collect(outOld);
  const newGroups = collect(outNew);
  const allGroups = new Set([...oldGroups.keys(), ...newGroups.keys()]);

  for (const group of allGroups) {
    const oldList = oldGroups.get(group) || [];
    const newList = newGroups.get(group) || [];
    if (oldList.length !== 1 || newList.length !== 1) {
      continue;
    }
    const o = oldList[0];
    const n = newList[0];
    if (o.row === n.row) {
      continue;
    }
    // 仅当一侧纯数字下标、另一侧非数字（uuid）时合并
    if (!(o.isIndex !== n.isIndex)) {
      continue;
    }
    const preferUuid = !n.isIndex ? n : !o.isIndex ? o : n;
    const drop = preferUuid.snapKey === o.snapKey ? n : o;

    if (outOld[drop.snapKey] !== undefined && outOld[preferUuid.snapKey] === undefined) {
      outOld[preferUuid.snapKey] = outOld[drop.snapKey];
      delete outOld[drop.snapKey];
    }
    if (outNew[drop.snapKey] !== undefined && outNew[preferUuid.snapKey] === undefined) {
      outNew[preferUuid.snapKey] = outNew[drop.snapKey];
      delete outNew[drop.snapKey];
    }
  }

  return { oldSnap: outOld, newSnap: outNew };
}
