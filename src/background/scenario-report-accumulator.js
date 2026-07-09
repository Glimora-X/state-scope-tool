import {
  filterRowsByWatchFields,
  findScenarioMeta,
  getMigrationScenarioTags,
  getScenarioLabel,
  normalizeScenarioPack,
  watchFieldToFieldId
} from '../shared/scenario-catalog.js';

function createScenarioRecord(meta) {
  return {
    tag: meta.tag,
    order: meta.order ?? 0,
    label: meta.label || getScenarioLabel(meta.tag),
    group: meta.group || '',
    checkpoint: meta.checkpoint || '',
    signOffMode: meta.signOffMode === 'manual' ? 'manual' : 'allowlist',
    watchFields: Array.isArray(meta.watchFields) ? meta.watchFields : [],
    steps: Array.isArray(meta.steps) ? meta.steps : [],
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

export function emptyScenarioReport(catalogPack) {
  const normalized = catalogPack ? normalizeScenarioPack(catalogPack) : null;
  // 无 catalog 时返回空报告，禁止用 LEGACY 9 项冒充领域验证清单
  const catalogList = normalized?.scenarios?.length ? normalized.scenarios : [];
  const scenarios = {};
  for (const meta of catalogList) {
    scenarios[meta.tag] = createScenarioRecord(meta);
  }
  for (const meta of catalogList) {
    const record = scenarios[meta.tag];
    seedWatchFieldRecords(record);
    record.allowlistFieldCount = getTargetFieldCount(record) || record.fields.length;
    record.unobservedFields = Math.max(0, record.allowlistFieldCount - record.readyFields);
  }
  return {
    boName: normalized?.boName || null,
    catalogVersion: normalized?.version || null,
    catalogTitle: normalized?.title || null,
    allowlistVersion: normalized?.allowlistVersion || null,
    hasNewChainObserved: false,
    updatedAt: 0,
    summary: recomputeSummary(scenarios),
    scenarios
  };
}

function getTargetFieldCount(record) {
  if (record.signOffMode === 'manual') {
    return 0;
  }
  if (record.watchFields?.length) {
    return record.watchFields.length;
  }
  return 0;
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

function seedWatchFieldRecords(record) {
  if (!record.watchFields?.length) {
    return;
  }
  const map = new Map(record.fields.map((item) => [item.fieldId, item]));
  for (const watch of record.watchFields) {
    const fieldId = watchFieldToFieldId(watch);
    if (!map.has(fieldId)) {
      map.set(fieldId, {
        fieldId,
        path: watch.path,
        stateType: watch.stateType || 'disabled',
        configKey: '',
        epochCount: 0,
        logicMismatchCount: 0,
        lastSeverity: 'unobserved',
        lastEpochId: null,
        scenarioReady: false,
        blockReason: '尚未观测'
      });
    }
  }
  record.fields = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
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
  if (record.signOffMode === 'manual') {
    if (record.epochCount === 0 && !record.markedComplete) {
      record.status = 'not_started';
      return;
    }
    record.status = record.markedComplete ? 'pass' : 'in_progress';
    return;
  }

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

  const target = getTargetFieldCount(record);
  if (target > 0 && record.readyFields === target) {
    record.status = 'pass';
    return;
  }

  if (!record.watchFields?.length && record.readyFields > 0 && record.blockedFields === 0) {
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
  seedWatchFieldRecords(record);

  const relevantRows = filterRowsByWatchFields(epoch.allowlistFieldResults || [], record.watchFields);
  const rowsToProcess = record.watchFields?.length ? relevantRows : epoch.allowlistFieldResults || [];
  const fieldMap = new Map(record.fields.map((item) => [item.fieldId, item]));

  for (const row of rowsToProcess) {
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
  record.allowlistFieldCount = getTargetFieldCount(record) || record.fields.length;
  record.readyFields = record.fields.filter((item) => item.scenarioReady).length;
  record.blockedFields = record.fields.filter((item) => item.logicMismatchCount > 0).length;
  record.unobservedFields = Math.max(0, record.allowlistFieldCount - record.readyFields);

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
  if (complete && record.signOffMode !== 'manual' && record.status !== 'pass') {
    return { ok: false, error: '仅 PASS 场景可 Mark Complete（manual 场景可直接签字）' };
  }
  record.markedComplete = !!complete;
  record.markedCompleteAt = complete ? Date.now() : null;
  if (record.signOffMode === 'manual' && complete) {
    record.status = 'pass';
  }
  report.summary = recomputeSummary(report.scenarios);
  report.updatedAt = Date.now();
  return { ok: true, record, summary: report.summary };
}

export function resetScenarioReport(report, catalogPack) {
  if (catalogPack) {
    return emptyScenarioReport(catalogPack);
  }
  return emptyScenarioReport(
    report?.catalogVersion ?
      {
        boName: report.boName,
        version: report.catalogVersion,
        title: report.catalogTitle,
        scenarios: Object.values(report.scenarios || {}).map((item) => ({
          tag: item.tag,
          label: item.label,
          group: item.group,
          checkpoint: item.checkpoint,
          signOffMode: item.signOffMode,
          watchFields: item.watchFields,
          steps: item.steps
        }))
      }
    : null
  );
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
        subline:
          active.signOffMode === 'manual' ?
            'manual 场景已签字'
          : `${active.readyFields}/${active.allowlistFieldCount} watch 字段就绪`
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
      catalogVersion: report.catalogVersion,
      catalogTitle: report.catalogTitle,
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
    'group',
    'status',
    'signOffMode',
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
      item.group,
      item.status,
      item.signOffMode,
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

export { getMigrationScenarioTags, findScenarioMeta };
