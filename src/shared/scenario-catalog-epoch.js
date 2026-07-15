/**
 * catalogEpoch = tag 规则体级内容身份（非仅 tag 列表）。
 *
 * 纳入：boName、version、每个 scenario 的 tag|id、setup、actions、assertFields、
 * allowlistBatch、规范化 watchFields。
 * 不纳入：note、title、checkpoint 文案噪音。
 *
 * 粒度注释（冻结）：不做字段级「部分继承」指纹；跨 catalogEpoch 禁止自动继承 PASS/BLOCK。
 * 重审信号：若领域 version 语义变更，须重评本函数 hash 输入。
 */

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableJson(value) {
  if (value == null) {
    return '';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function slugTag(id, index) {
  const raw = String(id || `s${index + 1}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || `s${index + 1}`;
}

function normalizeWatchFieldsForEpoch(watchFields) {
  if (!Array.isArray(watchFields)) {
    return [];
  }
  return [...watchFields]
    .map((w) => ({
      path: w?.path || '',
      stateType: w?.stateType || 'disabled',
      expected: w?.expected
    }))
    .filter((w) => w.path)
    .sort((a, b) => `${a.path}::${a.stateType}`.localeCompare(`${b.path}::${b.stateType}`));
}

function normalizeAssertFieldsForEpoch(assertFields) {
  if (!Array.isArray(assertFields)) {
    return [];
  }
  return [...assertFields]
    .map((a) => ({
      path: a?.path || '',
      stateType: a?.stateType || 'disabled',
      expected: a?.expected
    }))
    .filter((a) => a.path)
    .sort((a, b) => `${a.path}::${a.stateType}`.localeCompare(`${b.path}::${b.stateType}`));
}

export function computeCatalogEpoch(pack) {
  if (!pack?.scenarios?.length) {
    return '';
  }
  const rows = pack.scenarios.map((item, index) => {
    const tag = item.tag || slugTag(item.id, index);
    const id = item.group || item.id || tag;
    return {
      tag,
      id,
      setup: item.setup || '',
      actions: Array.isArray(item.actions) ? item.actions.map(String) : [],
      assertFields: normalizeAssertFieldsForEpoch(item.assertFields),
      allowlistBatch: Array.isArray(item.allowlistBatch) ? [...item.allowlistBatch].map(String).sort() : [],
      watchFields: normalizeWatchFieldsForEpoch(item.watchFields)
    };
  });
  rows.sort((a, b) => a.tag.localeCompare(b.tag));
  const payload = {
    boName: pack.boName || '',
    version: pack.version || '',
    scenarios: rows
  };
  return fnv1a32(stableJson(payload));
}

export function scenarioPackFingerprint(pack) {
  if (pack?.catalogEpoch) {
    return pack.catalogEpoch;
  }
  const epoch = computeCatalogEpoch(pack);
  if (epoch) {
    return epoch;
  }
  if (!pack?.scenarios?.length) {
    return '';
  }
  const ids = pack.scenarios
    .map((item) => item.tag || item.id || item.group || '')
    .join(',');
  return `${pack.boName || ''}|${pack.version || ''}|${pack.scenarios.length}|${ids}`;
}

export function attachCatalogEpoch(normalized, sourceOverride) {
  if (!normalized) {
    return null;
  }
  const source = sourceOverride || normalized.source || '';
  const withSource = { ...normalized, source };
  const catalogEpoch = computeCatalogEpoch(withSource);
  return { ...withSource, catalogEpoch };
}
