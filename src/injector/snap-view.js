import { classifyDetailRowKey } from './legacy-diagnostics.js';

export function formatVal(value) {
  if (value === undefined) {
    return '—';
  }
  if (value === true) {
    return '禁用';
  }
  if (value === false) {
    return '可编辑';
  }
  return String(value);
}

export function formatValLong(value) {
  if (value === undefined) {
    return '—';
  }
  if (value === true) {
    return 'true (disabled/不可编辑)';
  }
  if (value === false) {
    return 'false (enabled/可编辑)';
  }
  return String(value);
}

export function buildChangedSetFinalSnap(finalSnap, changedSample) {
  const display = {};
  for (const key of Object.keys(changedSample || {})) {
    if (finalSnap?.[key] !== undefined) {
      display[key] = finalSnap[key];
    } else if (changedSample[key] !== undefined) {
      display[key] = changedSample[key];
    }
  }
  return display;
}

export function pickMainKeys(snap) {
  const picked = {};
  for (const [key, value] of Object.entries(snap || {})) {
    if (key.startsWith('main.') && key.split('.').length === 3) {
      picked[key] = value;
    }
  }
  return picked;
}

export function pickDetailKeys(snap, changedSample) {
  const prefixes = new Set();
  for (const key of Object.keys(changedSample || {})) {
    const parts = key.split('.');
    if (parts.length >= 3 && parts[0] !== 'main') {
      prefixes.add(`${parts[0]}.${parts[1]}`);
    }
  }

  const picked = {};
  for (const [key, value] of Object.entries(snap || {})) {
    const prefix = key.split('.').slice(0, 2).join('.');
    if (prefixes.has(prefix)) {
      picked[key] = value;
    }
  }
  return picked;
}

export function hasDetailKeys(finalSnap, changedSample) {
  return Object.keys(changedSample || {}).some((key) => !key.startsWith('main.'));
}

export function parseStateKey(key) {
  const parts = String(key).split('.');
  const stateType = parts[parts.length - 1];
  if (stateType !== 'visible' && stateType !== 'disabled') {
    return null;
  }
  if (parts[0] === 'main' && parts.length === 3) {
    return { area: 'main', body: 'main', rowKey: null, field: parts[1], stateType, path: key };
  }
  if (parts.length === 4) {
    return {
      area: 'detail',
      body: parts[0],
      rowKey: parts[1],
      field: parts[2],
      stateType,
      path: key
    };
  }
  return null;
}

export function snapToRows(snap, { changedSample = {}, highlightChanged = false } = {}) {
  return Object.keys(snap || {})
    .sort()
    .map((path) => ({
      path,
      value: snap[path],
      label: formatVal(snap[path]),
      labelLong: formatValLong(snap[path]),
      changed: highlightChanged ? Object.prototype.hasOwnProperty.call(changedSample, path) : false,
      parsed: parseStateKey(path)
    }));
}

export function countDisabledStats(snap) {
  let disabled = 0;
  let enabled = 0;
  for (const value of Object.values(snap || {})) {
    if (value === true) {
      disabled += 1;
    } else if (value === false) {
      enabled += 1;
    }
  }
  return { disabled, enabled };
}

export function buildDetailGrids(finalSnap, changedSample, { allColumns = false } = {}) {
  const prefixes = new Set();
  if (allColumns) {
    for (const key of Object.keys(finalSnap || {})) {
      const parsed = parseStateKey(key);
      if (parsed?.area === 'detail') {
        prefixes.add(`${parsed.body}.${parsed.rowKey}`);
      }
    }
  } else {
    for (const key of Object.keys(changedSample || {})) {
      const parsed = parseStateKey(key);
      if (parsed?.area === 'detail') {
        prefixes.add(`${parsed.body}.${parsed.rowKey}`);
      }
    }
  }

  const grids = [];
  for (const prefix of prefixes) {
    const [body, rowKey] = prefix.split('.');
    const columns = [];
    for (const [key, value] of Object.entries(finalSnap || {})) {
      if (!key.startsWith(`${prefix}.`)) {
        continue;
      }
      const parsed = parseStateKey(key);
      if (!parsed || parsed.stateType !== 'disabled') {
        continue;
      }
      columns.push({
        field: parsed.field,
        path: key,
        value,
        label: formatVal(value),
        changed: Object.prototype.hasOwnProperty.call(changedSample, key)
      });
    }
    columns.sort((a, b) => a.field.localeCompare(b.field));
    grids.push({
      body,
      rowKey,
      rowLabel: classifyDetailRowKey(rowKey) === 'grid-index' ? `grid#${rowKey}` : rowKey,
      columns
    });
  }
  return grids;
}

export function summarizeDiffs(diffs) {
  const summary = {
    ok: 0,
    logicMismatch: 0,
    legacyOnly: 0,
    newOnly: 0,
    pending: 0,
    total: 0
  };
  for (const item of diffs || []) {
    summary.total += 1;
    if (item.severity === 'ok') {
      summary.ok += 1;
    } else if (item.severity === 'logic-mismatch') {
      summary.logicMismatch += 1;
    } else if (item.severity === 'legacy-only') {
      summary.legacyOnly += 1;
    } else if (item.severity === 'new-only') {
      summary.newOnly += 1;
    } else if (item.severity === 'pending') {
      summary.pending += 1;
    }
  }
  return summary;
}

export function groupDiffRows(diffs) {
  const main = [];
  const details = new Map();

  for (const row of diffs || []) {
    const parsed = parseStateKey(row.path);
    if (!parsed) {
      main.push(row);
      continue;
    }
    if (parsed.area === 'main') {
      main.push(row);
      continue;
    }
    const groupKey = `${parsed.body} (${parsed.rowKey})`;
    if (!details.has(groupKey)) {
      details.set(groupKey, {
        title: groupKey,
        body: parsed.body,
        rowKey: parsed.rowKey,
        rowLabel:
          classifyDetailRowKey(parsed.rowKey) === 'grid-index' ? `grid#${parsed.rowKey}` : parsed.rowKey,
        rows: []
      });
    }
    details.get(groupKey).rows.push({
      ...row,
      field: parsed.field,
      displayName: parsed.field
    });
  }

  return { main, details: [...details.values()] };
}
