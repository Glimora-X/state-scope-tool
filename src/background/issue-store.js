import { buildIssueFingerprint, buildIssueTitle, inferStateType, normalizeFieldPath } from './issue-fingerprint.js';

const ISSUES_KEY = 'ss:issues:v1';
const SNAPSHOTS_KEY = 'ss:issue-snapshots:v1';
const MAX_SNAPSHOTS = 50;
const MAX_EPOCH_IDS = 20;

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key]));
  });
}

function storageSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

function createEmptyStore() {
  return { items: {}, order: [] };
}

function newIssueId() {
  return `ssiss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadIssueStore() {
  const saved = await storageGet(ISSUES_KEY);
  if (!saved?.items) {
    return createEmptyStore();
  }
  return saved;
}

async function persistIssueStore(store) {
  await storageSet(ISSUES_KEY, store);
}

export async function listIssues() {
  const store = await loadIssueStore();
  return store.order.map((fp) => store.items[fp]).filter(Boolean);
}

export async function getIssue(fingerprint) {
  const store = await loadIssueStore();
  return store.items[fingerprint] || null;
}

async function saveSnapshot(snapshotId, epochPayload) {
  const saved = (await storageGet(SNAPSHOTS_KEY)) || {};
  saved[snapshotId] = {
    exportedAt: Date.now(),
    epoch: epochPayload
  };
  const keys = Object.keys(saved);
  if (keys.length > MAX_SNAPSHOTS) {
    for (const key of keys.slice(0, keys.length - MAX_SNAPSHOTS)) {
      delete saved[key];
    }
  }
  await storageSet(SNAPSHOTS_KEY, saved);
  return snapshotId;
}

export function buildIssueFromDiff({
  diff,
  epochPayload,
  tabId,
  scenarioTag,
  issueType = 'logic-mismatch'
}) {
  const boName = epochPayload.meta?.boName || 'unknown';
  const fieldPath = normalizeFieldPath(diff.path);
  const stateType = inferStateType(diff.path);
  const fingerprint = buildIssueFingerprint({
    boName,
    fieldPath,
    stateType,
    scenarioTag,
    issueType
  });

  return {
    fingerprint,
    boName,
    fieldPath,
    stateType,
    scenarioTag,
    issueType,
    title: buildIssueTitle({ boName, fieldPath, stateType, scenarioTag, issueType }),
    status: 'open',
    severity: issueType === 'logic-mismatch' ? 'major' : 'minor',
    labels: [boName, `scenario-${scenarioTag}`, issueType]
  };
}

export async function upsertIssue(input, epochPayload, tabId) {
  const store = await loadIssueStore();
  const now = Date.now();
  const fingerprint = input.fingerprint;
  let issue = store.items[fingerprint];
  const snapshotId = `snap_${epochPayload.id}_${tabId}_${now}`;

  if (epochPayload) {
    await saveSnapshot(snapshotId, epochPayload);
  }

  const evidence = {
    tabId,
    epochId: epochPayload?.id,
    route: epochPayload?.meta?.route || '',
    profile: epochPayload?.meta?.profile || '',
    trigger: epochPayload?.trigger || '',
    oldValue: input.oldValue,
    newValue: input.newValue,
    oldLabel: input.oldLabel,
    newLabel: input.newLabel,
    allowlistVersion: epochPayload?.allowlistMeta?.version || '',
    snapshotId,
    at: now
  };

  if (!issue) {
    issue = {
      id: newIssueId(),
      fingerprint,
      boName: input.boName,
      fieldPath: input.fieldPath,
      stateType: input.stateType,
      scenarioTag: input.scenarioTag,
      issueType: input.issueType,
      title: input.title,
      status: input.status || 'open',
      severity: input.severity || 'major',
      labels: input.labels || [],
      lastEvidence: evidence,
      occurrenceCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      epochIds: epochPayload?.id != null ? [epochPayload.id] : [],
      jira: {
        syncStatus: 'pending'
      },
      comments: [],
      statusHistory: [{ at: now, from: null, to: 'open', note: 'created' }]
    };
  } else {
    issue.lastEvidence = evidence;
    issue.occurrenceCount += 1;
    issue.lastSeenAt = now;
    if (epochPayload?.id != null) {
      issue.epochIds = [epochPayload.id, ...issue.epochIds.filter((id) => id !== epochPayload.id)].slice(
        0,
        MAX_EPOCH_IDS
      );
    }
    if (issue.status === 'closed' || issue.status === 'verified') {
      issue.status = 'open';
      issue.statusHistory.push({ at: now, from: 'closed', to: 'open', note: 'reopened by new evidence' });
    }
    if (issue.jira?.key) {
      issue.jira.syncStatus = 'stale';
    } else {
      issue.jira = { syncStatus: 'pending' };
    }
  }

  store.items[fingerprint] = issue;
  store.order = [fingerprint, ...store.order.filter((item) => item !== fingerprint)];
  await persistIssueStore(store);
  return issue;
}

export async function updateIssue(fingerprint, patch) {
  const store = await loadIssueStore();
  const issue = store.items[fingerprint];
  if (!issue) {
    return null;
  }
  const now = Date.now();
  if (patch.status && patch.status !== issue.status) {
    issue.statusHistory = issue.statusHistory || [];
    issue.statusHistory.push({
      at: now,
      from: issue.status,
      to: patch.status,
      note: patch.statusNote || ''
    });
    issue.status = patch.status;
  }
  if (patch.jira) {
    issue.jira = { ...(issue.jira || {}), ...patch.jira };
  }
  store.items[fingerprint] = issue;
  await persistIssueStore(store);
  return issue;
}

export async function deleteIssue(fingerprint) {
  const store = await loadIssueStore();
  if (!store.items[fingerprint]) {
    return false;
  }
  delete store.items[fingerprint];
  store.order = store.order.filter((item) => item !== fingerprint);
  await persistIssueStore(store);
  return true;
}

export function sanitizeIssueForExport(issue) {
  if (!issue) {
    return issue;
  }
  const copy = JSON.parse(JSON.stringify(issue));
  return copy;
}
