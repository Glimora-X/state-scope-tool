import { captureStatePatchesAsSnap } from './normalize.js';
import { buildLowcodeMainPath, buildLowcodeDetailPath, resolveMainFieldModel } from './lowcode-paths.js';

const STATE_TYPES = ['visible', 'disabled'];

/**
 * mdf applyStatePatches 写入的 shadowStore 结构：
 *   { 'main.currencyId': { __properties__: { disabled: { value: true } } }, ... }
 * 不是嵌套树。
 */
function pushShadowCandidate(candidates, store) {
  if (store && typeof store === 'object' && !candidates.includes(store)) {
    candidates.push(store);
  }
}

function readShadowStoreFromNode(node) {
  if (!node) {
    return null;
  }
  try {
    const viaGet = node.get?.('shadowStore') || node.get?.('stateShadowStore');
    if (viaGet && typeof viaGet === 'object') {
      return viaGet;
    }
  } catch {
    // ignore
  }
  if (node.shadowStore && typeof node.shadowStore === 'object') {
    return node.shadowStore;
  }
  return null;
}

/**
 * 低代码 shadow 轨：applyStatePatches(mode:shadow) 写入 rootViewModel.shadowStore。
 * 入口可能是 TemplateView.viewModel / root / biz.interlayerViewModel.rootViewModel。
 */
function flattenShadowStoreObject(store, flat) {
  for (const [boPath, node] of Object.entries(store || {})) {
    if (!node || typeof node !== 'object') {
      continue;
    }
    const props = node.__properties__;
    if (!props) {
      continue;
    }
    for (const stateType of STATE_TYPES) {
      const item = props[stateType];
      if (item && typeof item.value === 'boolean') {
        flat[`${boPath}.${stateType}`] = item.value;
      } else if (typeof item === 'boolean') {
        flat[`${boPath}.${stateType}`] = item;
      }
    }
  }
}

/** 表头 fieldModel._status.$shadow（applyStatePatches shadow 模式也会写这里） */
export function flattenAllowlistFieldShadows(viewModel, allowlistConfig) {
  const flat = {};
  if (!viewModel) {
    return flat;
  }

  const fields = allowlistConfig?.fields?.length ?
      allowlistConfig.fields
    : [
        { path: 'main.currencyId' },
        { path: 'main.exchangeRate' },
        { path: 'main.redBlueFlagEnum' },
        { path: 'main.vendorId' }
      ];

  for (const field of fields) {
    const path = field.path;
    if (!path || path.includes('{uuid}') || !path.startsWith('main.')) {
      continue;
    }
    try {
      const model = resolveMainFieldModel(viewModel, path);
      const fieldName = path.slice('main.'.length);
      Object.assign(flat, shadowEntriesFromFieldModel(model, fieldName, 'main', null));
    } catch {
      // ignore
    }
  }

  return flat;
}

export function flattenShadowStore(viewModel, bizApp, allowlistConfig) {
  const flat = {};
  if (!viewModel && !bizApp) {
    return flat;
  }

  const card = viewModel?.biz || viewModel?.root?.biz;
  const nodes = [
    viewModel,
    viewModel?.root,
    card,
    card?.interlayerViewModel?.rootViewModel,
    card?.interlayerViewModel,
    viewModel?.biz?.interlayerViewModel?.rootViewModel,
    viewModel?.biz?.interlayerViewModel,
    bizApp?.interlayerViewModel?.rootViewModel,
    bizApp?.interlayerViewModel,
    bizApp?.rootViewModel
  ].filter(Boolean);

  const candidates = [];
  for (const node of nodes) {
    pushShadowCandidate(candidates, readShadowStoreFromNode(node));
  }

  for (const store of candidates) {
    flattenShadowStoreObject(store, flat);
  }

  Object.assign(flat, flattenAllowlistFieldShadows(viewModel, allowlistConfig));
  return flat;
}

/** 诊断：shadowStore 与 field.$shadow 是否可读 */
export function probeShadowSources(viewModel, bizApp, allowlistConfig) {
  const root = viewModel?.root || viewModel;
  const storeFlat = {};
  const nodes = [root, bizApp?.interlayerViewModel?.rootViewModel, viewModel].filter(Boolean);
  const stores = [];
  for (const node of nodes) {
    const store = readShadowStoreFromNode(node);
    if (store) {
      stores.push({ node: node.constructor?.name || 'object', keys: Object.keys(store).slice(0, 8) });
      flattenShadowStoreObject(store, storeFlat);
    }
  }
  const fieldFlat = flattenAllowlistFieldShadows(viewModel, allowlistConfig);
  return {
    shadowStoreNodes: stores,
    shadowStoreFlatCount: Object.keys(storeFlat).length,
    fieldShadowFlatCount: Object.keys(fieldFlat).length,
    mergedFlatCount: Object.keys({ ...storeFlat, ...fieldFlat }).length,
    sample: { ...storeFlat, ...fieldFlat }
  };
}

export function discoverApplyStatePatchesTarget(viewModel) {
  if (!viewModel) {
    return null;
  }

  const chain = [
    viewModel.biz,
    viewModel.root?.biz,
    viewModel,
    viewModel.root,
    viewModel.interlayerViewModel
  ].filter(Boolean);

  for (const target of chain) {
    if (typeof target.applyStatePatches === 'function') {
      return { target, fn: target.applyStatePatches.bind(target) };
    }
    if (typeof target.doDispatch === 'function') {
      // doDispatch 是正式入口，由 wrap-lowcode 单独处理
      return null;
    }
  }

  return null;
}

export function shadowEntriesFromFieldModel(model, fieldName, bodyName, rowKey) {
  const flat = {};
  if (!model || typeof model.get !== 'function' || !fieldName) {
    return flat;
  }

  const prefix =
    rowKey == null || rowKey === undefined ?
      `main.${fieldName}`
    : `${bodyName || 'detailList'}.${rowKey}.${fieldName}`;

  for (const stateType of STATE_TYPES) {
    try {
      const shadow =
        model.get?.(`$shadow.${stateType}`) ??
        model._status?.$shadow?.[stateType] ??
        model._status?.shadow?.[stateType];
      if (typeof shadow === 'boolean') {
        flat[`${prefix}.${stateType}`] = shadow;
      } else if (shadow && typeof shadow.value === 'boolean') {
        flat[`${prefix}.${stateType}`] = shadow.value;
      }
    } catch {
      // ignore
    }
  }

  return flat;
}

export function normalizeLowcodePatchKeys(flat) {
  return captureStatePatchesAsSnap(
    Object.fromEntries(
      Object.entries(flat || {}).map(([key, value]) => {
        const parts = key.split('.');
        if (parts.length === 2 && (parts[1] === 'visible' || parts[1] === 'disabled')) {
          return [`main.${key}`, value];
        }
        return [key, value];
      })
    )
  );
}

export function buildPathFromFieldContext({ bodyName, rowKey, fieldName, stateType }) {
  if (rowKey == null || rowKey === undefined) {
    return buildLowcodeMainPath(fieldName, stateType);
  }
  return buildLowcodeDetailPath(bodyName, rowKey, fieldName, stateType);
}
