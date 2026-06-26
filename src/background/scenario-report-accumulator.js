import { getScenarioLabel, MIGRATION_SCENARIO_TAGS } from '../shared/scenario-catalog.js';

export function emptyScenarioReport() {
  const scenarios = {};
  for (const tag of MIGRATION_SCENARIO_TAGS) {
    scenarios[tag] = createScenarioRecord(tag);
  }
  return {
    boName: null,
    allowlistVersion: null,
    hasNewChainObserved: false,
    updatedAt: 0,
    summary: recomputeSummary(scenarios),
    scenarios
  };
}

function createScenarioRecord(tag) {
  return {
    tag,
    label: getScenarioLabel(tag),
    status: 'not_started',
    markedComplete: false,
    markedCompleteAt: null,
    epochCount: 0,
    logicMismatchCount: 0,
    allowlistFieldCount: 0,
    readyFields: 0,
    blockedFields: 0,
    unobservedFields: 0,
    fields: []
  };
}

function fieldRecordFromRow(row) {
  return {
    fieldId: row.fieldId,
    path: row.path,
    stateType: row.stateType,
    configKey: row.configKey,
    epochCount: 0,
    logicMismatchCount: 0,
    lastSeverity: 'unobserved',
    lastEpochId: null,
    scenarioReady: false,
    blockReason: '尚未观测'
  };
}

function recomputeFieldReady(record, hasNewChainObserved) {
  if (!hasNewChainObserved) {
    record.scenarioReady = false;
    record.blockReason = 'new 轨未接入';
    return;
  }
  if (record.logicMismatchCount > 0) {
    record.scenarioReady = false;
    record.blockReason = `logic-mismatch × ${record.logicMismatchCount}`;
    return;
  }
  if (record.epochCount === 0) {
    record.scenarioReady = false;
    record.blockReason = '尚未观测';
    return;
  }
  record.scenarioReady = true;
  record.blockReason = '';
}

function recomputeScenarioStatus(record, hasNewChainObserved) {
  if (record.epochCount === 0) {
    record.status = 'not_started';
    record.markedComplete = false;
    record.markedCompleteAt = null;
    return;
  }

  if (!hasNewChainObserved) {
    record.status = 'in_progress';
    return;
  }

  if (record.blockedFields > 0 || record.logicMismatchCount > 0) {
    record.status = 'block';
    record.markedComplete = false;
    record.markedCompleteAt = null;
    return;
  }

  if (record.allowlistFieldCount > 0 && record.readyFields === record.allowlistFieldCount) {
    record.status = 'pass';
    return;
  }

  record.status = 'in_progress';
}

function recomputeSummary(scenarios) {
  const list = Object.values(scenarios || {});
  return {
    total: list.length,
    pass: list.filter((item) => item.status === 'pass').length,
    block: list.filter((item) => item.status === 'block').length,
    inProgress: list.filter((item) => item.status === 'in_progress').length,
    notStarted: list.filter((item) => item.status === 'not_started').length,
    markedComplete: list.filter((item) => item.markedComplete).length
  };
}

export function accumulateScenarioReport(report, epoch) {
  if (!report) {
    report = emptyScenarioReport();
  }

  const tag = epoch.scenarioTag;
  if (!tag || !report.scenarios[tag]) {
    if (epoch.hasNewChain) {
      report.hasNewChainObserved = true;
    }
    if (epoch.allowlistMeta?.boName) {
      report.boName = epoch.allowlistMeta.boName;
      report.allowlistVersion = epoch.allowlistMeta.version || report.allowlistVersion;
    }
    report.updatedAt = Date.now();
    report.summary = recomputeSummary(report.scenarios);
    return report;
  }

  if (epoch.hasNewChain) {
    report.hasNewChainObserved = true;
  }
  if (epoch.allowlistMeta?.boName) {
    report.boName = epoch.allowlistMeta.boName;
    report.allowlistVersion = epoch.allowlistMeta.version || report.allowlistVersion;
  }

  const record = report.scenarios[tag];
  record.epochCount += 1;
  const fieldMap = new Map(record.fields.map((item) => [item.fieldId, item]));

  for (const row of epoch.allowlistFieldResults || []) {
    if (!fieldMap.has(row.fieldId)) {
      fieldMap.set(row.fieldId, fieldRecordFromRow(row));
    }
    const field = fieldMap.get(row.fieldId);
    field.path = row.path;
    field.stateType = row.stateType;
    field.configKey = row.configKey;
    field.epochCount += 1;
    field.lastEpochId = epoch.id;
    field.lastSeverity = row.severity;
    if (row.severity === 'logic-mismatch') {
      field.logicMismatchCount += 1;
      record.logicMismatchCount += 1;
    }
    recomputeFieldReady(field, report.hasNewChainObserved);
  }

  record.fields = [...fieldMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  record.allowlistFieldCount = record.fields.length;
  record.readyFields = record.fields.filter((item) => item.scenarioReady).length;
  record.blockedFields = record.fields.filter((item) => item.logicMismatchCount > 0).length;
  record.unobservedFields = record.fields.filter((item) => item.epochCount === 0).length;

  recomputeScenarioStatus(record, report.hasNewChainObserved);
  report.updatedAt = Date.now();
  report.summary = recomputeSummary(report.scenarios);
  return report;
}

export function markScenarioComplete(report, scenarioTag, complete = true) {
  const record = report?.scenarios?.[scenarioTag];
  if (!record) {
    return { ok: false, error: '未知场景' };
  }
  if (complete && record.status !== 'pass') {
    return { ok: false, error: '仅 PASS 场景可 Mark Complete' };
  }
  record.markedComplete = !!complete;
  record.markedCompleteAt = complete ? Date.now() : null;
  report.summary = recomputeSummary(report.scenarios);
  report.updatedAt = Date.now();
  return { ok: true, record };
}

export function resetScenarioReport(report) {
  return emptyScenarioReport();
}

export function getScenarioVerdict(report, activeTag) {
  if (!report) {
    return {
      status: 'idle',
      headline: '场景回归未开始',
      subline: '选择场景并操作单据，allowlist 字段将按场景累计'
    };
  }

  const summary = report.summary || {};
  if (summary.block > 0) {
    return {
      status: 'error',
      headline: `BLOCK · ${summary.block} 个场景存在 logic-mismatch`,
      subline: `PASS ${summary.pass}/${summary.total} · 已签字 ${summary.markedComplete}`
    };
  }

  if (activeTag && report.scenarios[activeTag]) {
    const active = report.scenarios[activeTag];
    if (active.status === 'pass') {
      return {
        status: 'ok',
        headline: `本场景 PASS · ${active.label}`,
        subline: `${active.readyFields}/${active.allowlistFieldCount} allowlist 字段就绪`
      };
    }
    if (active.status === 'block') {
      return {
        status: 'error',
        headline: `本场景 BLOCK · ${active.label}`,
        subline: `${active.blockedFields} 个字段 logic-mismatch`
      };
    }
    if (active.status === 'in_progress') {
      return {
        status: 'warn',
        headline: `进行中 · ${active.label}`,
        subline: `已观测 ${active.epochCount} 个 Epoch`
      };
    }
  }

  if (summary.pass === summary.total && summary.total > 0) {
    return {
      status: 'ok',
      headline: `全部场景 PASS · ${summary.pass}/${summary.total}`,
      subline: `已签字 ${summary.markedComplete}/${summary.total}`
    };
  }

  return {
    status: 'warn',
    headline: `进行中 · PASS ${summary.pass}/${summary.total}`,
    subline: `未开始 ${summary.notStarted} · 已签字 ${summary.markedComplete}`
  };
}

export function exportScenarioReportJson(report, runtime) {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      boName: report.boName,
      allowlistVersion: report.allowlistVersion,
      hasNewChainObserved: report.hasNewChainObserved,
      runtime: runtime || {},
      summary: report.summary,
      scenarios: Object.values(report.scenarios || {})
    },
    null,
    2
  );
}

export function exportScenarioReportCsv(report) {
  const header = [
    'scenarioTag',
    'label',
    'status',
    'markedComplete',
    'epochCount',
    'logicMismatchCount',
    'allowlistFieldCount',
    'readyFields',
    'blockedFields'
  ];
  const rows = Object.values(report.scenarios || {}).map((item) =>
    [
      item.tag,
      item.label,
      item.status,
      item.markedComplete ? 'true' : 'false',
      item.epochCount,
      item.logicMismatchCount,
      item.allowlistFieldCount,
      item.readyFields,
      item.blockedFields
    ]
      .map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`)
      .join(',')
  );
  return [header.join(','), ...rows].join('\n');
}
