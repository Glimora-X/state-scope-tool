import { upsertIssue, buildIssueFromDiff } from './issue-store.js';

export async function collectIssuesFromEpoch(epochPayload, tabId, settings) {
  if (settings?.autoCollectIssues === false) {
    return [];
  }

  const scenarioTag = epochPayload?.scenarioTag;
  if (!scenarioTag || scenarioTag === 'unknown') {
    return [];
  }

  const mismatches = (epochPayload.diffs || []).filter((row) => row.severity === 'logic-mismatch');
  const upserted = [];

  for (const diff of mismatches) {
    const draft = buildIssueFromDiff({
      diff,
      epochPayload,
      tabId,
      scenarioTag,
      issueType: 'logic-mismatch'
    });
    const issue = await upsertIssue(
      {
        ...draft,
        oldValue: diff.old,
        newValue: diff.new,
        oldLabel: diff.oldLabel,
        newLabel: diff.newLabel
      },
      epochPayload,
      tabId
    );
    upserted.push(issue);
  }

  return upserted;
}

export async function promoteAnomalyToIssue(epochPayload, tabId, anomaly, scenarioTag) {
  const diff = (epochPayload.diffs || []).find((row) => row.path === anomaly.path) || {
    path: anomaly.path,
    severity: anomaly.severity || 'logic-mismatch',
    oldLabel: anomaly.message,
    newLabel: '—'
  };

  const draft = buildIssueFromDiff({
    diff,
    epochPayload,
    tabId,
    scenarioTag,
    issueType: diff.severity === 'logic-mismatch' ? 'logic-mismatch' : 'manual'
  });

  return upsertIssue(
    {
      ...draft,
      oldLabel: diff.oldLabel,
      newLabel: diff.newLabel
    },
    epochPayload,
    tabId
  );
}
