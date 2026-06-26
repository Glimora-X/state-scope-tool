import { formatVal } from './snap-view.js';

export function buildAllowlistPathSet(config) {
  const set = new Set();
  if (!config?.fields) {
    return set;
  }
  for (const field of config.fields) {
    if (field.path) {
      set.add(field.path);
    }
  }
  return set;
}

export function stripStateSuffix(path) {
  return String(path).replace(/\.(visible|disabled)$/, '');
}

export function matchAllowlistPath(allowlistPath, snapKey) {
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

function findDiffForField(field, diffs) {
  const stateType = field.stateType || 'disabled';
  const preferredSuffix = `.${stateType}`;

  let hit = (diffs || []).find(
    (row) => matchAllowlistPath(field.path, row.path) && row.path.endsWith(preferredSuffix)
  );
  if (hit) {
    return hit;
  }

  hit = (diffs || []).find((row) => matchAllowlistPath(field.path, row.path));
  return hit || null;
}

export function buildAllowlistFieldResults(config, diffs, hasNewChain) {
  if (!config?.fields?.length) {
    return [];
  }

  return config.fields.map((field) => {
    const stateType = field.stateType || 'disabled';
    const fieldId = `${field.path}::${stateType}`;
    const diff = findDiffForField(field, diffs);
    const snapKey = diff?.path || `${field.path}.${stateType}`;

    let severity = 'unobserved';
    let oldLabel = '—';
    let newLabel = '—';
    let resultLabel = '未观测';

    if (diff) {
      if (!hasNewChain) {
        severity = diff.severity === 'logic-mismatch' ? 'logic-mismatch' : 'pending';
        oldLabel = formatVal(diff.old);
        newLabel = '—';
        resultLabel = severity === 'logic-mismatch' ? 'logic-mismatch' : '待接入';
      } else {
        severity = diff.severity || 'ok';
        oldLabel = formatVal(diff.old);
        newLabel = formatVal(diff.new);
        resultLabel = severity;
      }
    }

    return {
      fieldId,
      path: field.path,
      stateType,
      snapKey,
      configKey: field.configKey || '',
      oldEntry: field.oldEntry || '',
      severity,
      oldLabel,
      newLabel,
      resultLabel,
      cutoverReady: hasNewChain && severity !== 'logic-mismatch' && severity !== 'unobserved'
    };
  });
}

export function buildAllowlistMeta(config) {
  if (!config) {
    return null;
  }
  return {
    boName: config.boName || '',
    version: config.version || '',
    fieldCount: config.fields?.length || 0,
    note: config.note || ''
  };
}
