import { classifyDetailRowKey } from './legacy-diagnostics.js';

export function formatEpochTime(ts) {
  if (!ts) {
    return '—';
  }
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function buildScopeFlow(scope, counts) {
  if (!scope && !counts) {
    return [];
  }

  const steps = [];

  if ((scope?.mainInChangedSet || 0) > 0) {
    steps.push({
      icon: '1',
      title: '表头有变更',
      detail: `${scope.mainInChangedSet} 个字段进入变更集`
    });
  }

  if ((scope?.mainRecalcCount || 0) > 0) {
    steps.push({
      icon: '↓',
      title: '表头状态重算',
      detail: `checkMainFieldState 重算 ${scope.mainRecalcCount} 个字段`
    });
  }

  if ((scope?.detailRowsInChangedSet || 0) > 0) {
    steps.push({
      icon: '2',
      title: '明细行有变更',
      detail: `${scope.detailRowsInChangedSet} 行进入变更集`
    });
  }

  if ((scope?.detailRecalcRows || 0) > 0) {
    steps.push({
      icon: '↓',
      title: '明细状态重算',
      detail: `checkChangeStates 重算 ${scope.detailRecalcRows} 行`
    });
  }

  if (counts?.finalSnap) {
    steps.push({
      icon: '✓',
      title: '终态快照',
      detail: `共 ${counts.finalSnap} 条状态路径写入快照`
    });
  }

  return steps;
}

export function buildEpochHealth(epoch) {
  const mismatch = epoch.diffSummary?.logicMismatch || 0;
  const changed = epoch.counts?.changedSample || 0;
  const hasNew = !!epoch.hasNewChain;

  if (mismatch > 0) {
    return {
      status: 'error',
      headline: `发现 ${mismatch} 个逻辑差异`,
      subline: 'old 与 new 状态不一致，优先排查'
    };
  }

  if (hasNew) {
    return {
      status: 'ok',
      headline: '本次双轨一致',
      subline: changed ? `${changed} 个变更字段均已对齐` : '无变更字段'
    };
  }

  if (changed > 0) {
    return {
      status: 'warn',
      headline: `已捕获 ${changed} 个变更字段`,
      subline: 'new 轨未接入，Diff 为 old 预览'
    };
  }

  return {
    status: 'idle',
    headline: '本次无字段变更',
    subline: 'Epoch 已记录，可继续操作单据'
  };
}

export function buildTimelineCard(epoch, prevEpoch) {
  const health = buildEpochHealth(epoch);
  const changed = epoch.counts?.changedSample || 0;
  const prevChanged = prevEpoch?.counts?.changedSample;
  let deltaHint = '';

  if (prevChanged != null && prevChanged !== changed) {
    const delta = changed - prevChanged;
    deltaHint = delta > 0 ? `+${delta} 变更` : `${delta} 变更`;
  }

  return {
    id: epoch.id,
    time: formatEpochTime(epoch.startedAt),
    trigger: epoch.trigger,
    changedCount: changed,
    finalCount: epoch.counts?.finalSnap || 0,
    mismatchCount: epoch.diffSummary?.logicMismatch || 0,
    status: health.status,
    statusLabel:
      health.status === 'error' ? 'mismatch'
      : health.status === 'warn' ? `${changed} 字段`
      : changed > 0 ? `${changed} 字段` : '无变化',
    deltaHint
  };
}

export function buildAnomalies(epoch) {
  const diffs = epoch.diffs || [];
  const mismatches = diffs.filter((row) => row.severity === 'logic-mismatch');
  const source = mismatches.length ? mismatches : diffs.filter((row) => row.severity === 'pending');

  return source.slice(0, 6).map((row) => ({
    path: row.path,
    field: row.displayName || row.path.split('.').slice(-2, -1)[0] || row.path,
    gridHint: row.gridHint,
    severity: row.severity,
    message:
      row.severity === 'logic-mismatch' ?
        `${row.oldLabel || '—'} → ${row.newLabel || '—'}`
      : `${row.oldLabel || '—'}（new 待接入）`,
    resultLabel: row.resultLabel || row.severity
  }));
}

export function groupChangedByBusiness(rows) {
  const main = [];
  const detailMap = new Map();

  for (const row of rows || []) {
    const parsed = row.parsed;
    if (!parsed || parsed.area === 'main') {
      const field = parsed?.field || row.path.split('.')[1] || row.path;
      main.push({
        field,
        label: row.label,
        path: row.path,
        changed: row.changed,
        stateType: parsed?.stateType || 'disabled'
      });
      continue;
    }

    const groupKey = `${parsed.body}.${parsed.rowKey}`;
    if (!detailMap.has(groupKey)) {
      detailMap.set(groupKey, {
        body: parsed.body,
        rowKey: parsed.rowKey,
        rowLabel:
          classifyDetailRowKey(parsed.rowKey) === 'grid-index' ? `第 ${parsed.rowKey} 行` : parsed.rowKey,
        fields: []
      });
    }

    detailMap.get(groupKey).fields.push({
      field: parsed.field,
      label: row.label,
      path: row.path,
      changed: row.changed,
      stateType: parsed.stateType
    });
  }

  return {
    main,
    details: [...detailMap.values()]
  };
}

export function buildImpactStats(epoch) {
  const mainCount = epoch.sections?.main?.count || 0;
  const detailCount = epoch.sections?.detail?.count || 0;

  return {
    main: mainCount,
    detail: detailCount,
    changed: epoch.counts?.changedSample || 0,
    final: epoch.counts?.finalSnap || 0,
    mismatch: epoch.diffSummary?.logicMismatch || 0,
    ok: epoch.diffSummary?.ok || 0
  };
}
