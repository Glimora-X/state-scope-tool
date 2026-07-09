import goodsIssueL3 from '../../scenarios/GoodsIssue.L3.v1.json';

function stripStateSuffix(path) {
  return String(path).replace(/\.(visible|disabled)$/, '');
}

function matchAllowlistPath(allowlistPath, snapKey) {
  const key = stripStateSuffix(snapKey);
  if (!allowlistPath) {
    return false;
  }
  if (allowlistPath.includes('{uuid}')) {
    const pattern =
      '^' +
      allowlistPath
        .replace(/\{uuid\}/g, '[^.]+')
        .replace(/\./g, '\\.') +
      '(\\.(visible|disabled))?$';
    return new RegExp(pattern).test(snapKey) || new RegExp(pattern).test(key);
  }
  return key === allowlistPath || snapKey === `${allowlistPath}.visible` || snapKey === `${allowlistPath}.disabled`;
}

/** 仅作无 catalog 时的占位；领域 BO 必须上传 SSOT，不再静默用这套冒充验证清单 */
export const LEGACY_SCENARIO_CATALOG = [
  { tag: 'new', label: '新增', checkpoint: '表头 + 明细初始态', order: 0, signOffMode: 'allowlist', watchFields: [], steps: [] },
  { tag: 'edit', label: '编辑', checkpoint: '表头 + 明细初始态', order: 1, signOffMode: 'allowlist', watchFields: [], steps: [] },
  { tag: 'view', label: '查看', checkpoint: '表头 + 明细初始态', order: 2, signOffMode: 'allowlist', watchFields: [], steps: [] },
  { tag: 'copy-new', label: '复制新增', checkpoint: '表头 + 明细初始态', order: 3, signOffMode: 'allowlist', watchFields: [], steps: [] },
  { tag: 'audit-edit', label: '审核中修改', checkpoint: 'Scenario 规则', order: 4, signOffMode: 'allowlist', watchFields: [], steps: [] },
  { tag: 'detail-row-crud', label: '子表增删复制行', checkpoint: 'uuid 下行状态不串、不残留', order: 5, signOffMode: 'allowlist', watchFields: [], steps: [] },
  { tag: 'header-linkage', label: '表头改联动字段', checkpoint: '仅受影响字段变化', order: 6, signOffMode: 'allowlist', watchFields: [], steps: [] },
  { tag: 'nested-detail', label: '孙表嵌套', checkpoint: '路径完整', order: 7, signOffMode: 'allowlist', watchFields: [], steps: [] },
  { tag: 'data-grid-edit', label: 'data-grid-edit', checkpoint: '列表模式、选择态与状态分离', order: 8, signOffMode: 'allowlist', watchFields: [], steps: [] },
  { tag: 'manual', label: '手动标记', checkpoint: '非 §7.4 标准场景', order: 99, signOffMode: 'manual', watchFields: [], steps: [] }
];

/** @deprecated 使用 resolveScenarioCatalog */
export const SCENARIO_CATALOG = LEGACY_SCENARIO_CATALOG;

/**
 * 工具仓仅保留传统试点 GoodsIssue 的 L3 包。
 * 低代码等领域 BO（如 OutsourceIssue）禁止内置副本，必须上传领域 SSOT。
 */
export const BUNDLED_SCENARIO_PACKS = {
  GoodsIssue: goodsIssueL3
};

function parseCompareField(path) {
  const raw = String(path || '');
  const match = raw.match(/^(.*)\.(visible|disabled)$/);
  if (match) {
    return { path: match[1], stateType: match[2] };
  }
  return { path: raw, stateType: 'disabled' };
}

function watchFieldsFromAssert(assertFields) {
  if (!Array.isArray(assertFields)) {
    return [];
  }
  return assertFields
    .filter((item) => item?.path)
    .map((item) => ({
      path: item.path,
      stateType: item.stateType || 'disabled',
      expected: item.expected
    }));
}

function watchFieldsFromCompareFields(compareFields) {
  if (!Array.isArray(compareFields)) {
    return [];
  }
  return compareFields.map(parseCompareField).filter((item) => item.path);
}

function isDomainSsotPack(pack) {
  const first = pack?.scenarios?.[0];
  if (!first) {
    return false;
  }
  // 工具 L3：有 tag；领域 SSOT：有 id/setup/assertFields，无 tag
  return !first.tag && !!(first.id || first.setup || first.assertFields || first.actions);
}

function slugTag(id, index) {
  const raw = String(id || `s${index + 1}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || `s${index + 1}`;
}

function normalizeSsotScenarioItem(item, index, pack) {
  const id = item.id || `S${index + 1}`;
  const tag = slugTag(id, index);
  let watchFields = watchFieldsFromAssert(item.assertFields);
  if (!watchFields.length && Array.isArray(item.allowlistBatch) && item.allowlistBatch.length) {
    watchFields = watchFieldsFromCompareFields(pack.stateScopeProfile?.compareFields);
  }

  const steps = [];
  if (item.setup) {
    steps.push({ id: `${id}-setup`, action: item.setup, expect: '按 SSOT setup 准备数据/页面' });
  }
  (item.actions || []).forEach((action, actionIndex) => {
    steps.push({
      id: `${id}-a${actionIndex + 1}`,
      action: String(action),
      expect: watchFields.length ? '执行后 Diff / assertFields 对照' : '执行后人工确认'
    });
  });

  return {
    tag,
    order: (index + 1) * 10,
    group: id,
    label: item.setup ? `${id} · ${item.setup}` : id,
    checkpoint: item.setup || '',
    signOffMode: watchFields.length ? 'allowlist' : 'manual',
    watchFields,
    steps,
    allowlistBatch: Array.isArray(item.allowlistBatch) ? item.allowlistBatch : [],
    assertFields: Array.isArray(item.assertFields) ? item.assertFields : []
  };
}

function normalizeToolScenarioItem(item) {
  return {
    tag: item.tag,
    order: item.order ?? 0,
    group: item.group || '',
    label: item.label || item.tag,
    checkpoint: item.checkpoint || '',
    signOffMode: item.signOffMode === 'manual' ? 'manual' : 'allowlist',
    watchFields: Array.isArray(item.watchFields) ? item.watchFields : [],
    steps: Array.isArray(item.steps) ? item.steps : []
  };
}

/**
 * 同时接受：
 * 1) 工具 L3 包（tag / steps / watchFields）
 * 2) 领域 SSOT（id / setup / actions / assertFields / stateScopeProfile）
 */
export function normalizeScenarioPack(pack) {
  if (!pack?.scenarios?.length) {
    return null;
  }

  const ssot = isDomainSsotPack(pack);
  const scenarios = ssot ?
      pack.scenarios.map((item, index) => normalizeSsotScenarioItem(item, index, pack))
    : pack.scenarios
        .filter((item) => item?.tag)
        .map((item) => normalizeToolScenarioItem(item))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (!scenarios.length) {
    return null;
  }

  if (!ssot) {
    scenarios.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  return {
    boName: pack.boName || '',
    version: pack.version || '',
    title: pack.title || pack.boName || '',
    allowlistVersion: pack.allowlistVersion || pack.allowlistRef || '',
    note: pack.note || (ssot ? '领域 SSOT 上传' : ''),
    profile: pack.profile || '',
    source: ssot ? 'ssot-upload' : pack.source || 'tool-l3',
    stateScopeProfile: pack.stateScopeProfile || null,
    scenarios
  };
}

export function getBundledScenarioPack(boName) {
  if (!boName) {
    return null;
  }
  const raw = BUNDLED_SCENARIO_PACKS[boName];
  return raw ? normalizeScenarioPack(raw) : null;
}

export function resolveScenarioCatalog(packOrBoName) {
  if (typeof packOrBoName === 'string') {
    return getBundledScenarioPack(packOrBoName)?.scenarios || [];
  }
  if (packOrBoName?.scenarios?.length) {
    return normalizeScenarioPack(packOrBoName)?.scenarios || [];
  }
  return [];
}

export function getMigrationScenarioTags(catalog) {
  const list = catalog || [];
  return list.filter((item) => item.tag !== 'manual').map((item) => item.tag);
}

/** @deprecated */
export const MIGRATION_SCENARIO_TAGS = getMigrationScenarioTags(LEGACY_SCENARIO_CATALOG);

export function findScenarioMeta(tag, catalog) {
  const list = catalog || [];
  return list.find((item) => item.tag === tag) || null;
}

export function getScenarioLabel(tag, catalog) {
  return findScenarioMeta(tag, catalog)?.label || tag || '—';
}

export function getScenarioCheckpoint(tag, catalog) {
  return findScenarioMeta(tag, catalog)?.checkpoint || '';
}

export function getScenarioSteps(tag, catalog) {
  return findScenarioMeta(tag, catalog)?.steps || [];
}

export function getScenarioGroup(tag, catalog) {
  return findScenarioMeta(tag, catalog)?.group || '';
}

export function watchFieldToFieldId(watchField) {
  if (!watchField?.path) {
    return '';
  }
  const stateType = watchField.stateType || 'disabled';
  return `${watchField.path}::${stateType}`;
}

export function matchWatchFieldToRow(watchField, row) {
  if (!watchField?.path || !row) {
    return false;
  }
  const stateType = watchField.stateType || 'disabled';
  if (row.stateType && row.stateType !== stateType) {
    return false;
  }
  const snapKey = row.snapKey || `${row.path}.${stateType}`;
  return matchAllowlistPath(watchField.path, snapKey) || matchAllowlistPath(watchField.path, row.path);
}

export function filterRowsByWatchFields(rows, watchFields) {
  if (!watchFields?.length) {
    return rows || [];
  }
  return (rows || []).filter((row) => watchFields.some((watch) => matchWatchFieldToRow(watch, row)));
}

export function summarizeScenarioPack(pack) {
  const normalized = normalizeScenarioPack(pack);
  if (!normalized) {
    return null;
  }
  return {
    boName: normalized.boName,
    version: normalized.version,
    title: normalized.title,
    allowlistVersion: normalized.allowlistVersion,
    note: normalized.note,
    source: normalized.source,
    scenarioCount: normalized.scenarios.length
  };
}
