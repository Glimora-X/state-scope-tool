export function emptyCutoverReport() {
  return {
    boName: null,
    allowlistVersion: null,
    hasNewChainObserved: false,
    updatedAt: 0,
    summary: {
      totalFields: 0,
      readyFields: 0,
      blockedFields: 0,
      unobservedFields: 0
    },
    fields: []
  };
}

function fieldRecordFromRow(row) {
  return {
    fieldId: row.fieldId,
    path: row.path,
    stateType: row.stateType,
    configKey: row.configKey,
    oldEntry: row.oldEntry,
    epochCount: 0,
    logicMismatchCount: 0,
    pendingCount: 0,
    unobservedCount: 0,
    lastSeverity: 'unobserved',
    lastMismatchEpochId: null,
    lastEpochId: null,
    cutoverReady: false,
    blockReason: '尚未观测'
  };
}

function recomputeFieldReady(record, hasNewChainObserved) {
  if (!hasNewChainObserved) {
    record.cutoverReady = false;
    record.blockReason = 'new 轨未接入';
    return;
  }
  if (record.logicMismatchCount > 0) {
    record.cutoverReady = false;
    record.blockReason = `logic-mismatch × ${record.logicMismatchCount}`;
    return;
  }
  if (record.epochCount === 0) {
    record.cutoverReady = false;
    record.blockReason = '尚未观测';
    return;
  }
  record.cutoverReady = true;
  record.blockReason = '';
}

function recomputeSummary(report) {
  const fields = report.fields;
  report.summary = {
    totalFields: fields.length,
    readyFields: fields.filter((item) => item.cutoverReady).length,
    blockedFields: fields.filter((item) => item.logicMismatchCount > 0).length,
    unobservedFields: fields.filter((item) => item.epochCount === 0).length
  };
}

export function accumulateCutoverReport(report, epoch) {
  if (!report) {
    report = emptyCutoverReport();
  }

  if (epoch.hasNewChain) {
    report.hasNewChainObserved = true;
  }
  if (epoch.allowlistMeta?.boName) {
    report.boName = epoch.allowlistMeta.boName;
    report.allowlistVersion = epoch.allowlistMeta.version || report.allowlistVersion;
  }

  const map = new Map(report.fields.map((item) => [item.fieldId, item]));

  for (const row of epoch.allowlistFieldResults || []) {
    if (!map.has(row.fieldId)) {
      map.set(row.fieldId, fieldRecordFromRow(row));
    }
    const record = map.get(row.fieldId);
    record.path = row.path;
    record.stateType = row.stateType;
    record.configKey = row.configKey;
    record.oldEntry = row.oldEntry;
    record.epochCount += 1;
    record.lastEpochId = epoch.id;
    record.lastSeverity = row.severity;

    if (row.severity === 'logic-mismatch') {
      record.logicMismatchCount += 1;
      record.lastMismatchEpochId = epoch.id;
    } else if (row.severity === 'pending') {
      record.pendingCount += 1;
    } else if (row.severity === 'unobserved') {
      record.unobservedCount += 1;
    }

    recomputeFieldReady(record, report.hasNewChainObserved);
  }

  report.fields = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  report.updatedAt = Date.now();
  recomputeSummary(report);
  return report;
}
