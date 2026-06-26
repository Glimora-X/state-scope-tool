import { getScenarioLabel } from '../shared/scenario-catalog.js';
import { sanitizeIssueForExport } from './issue-store.js';

function basicAuth(email, apiToken) {
  return btoa(`${email}:${apiToken}`);
}

function buildDescription(issue) {
  const ev = issue.lastEvidence || {};
  return [
    'h2. 场景',
    getScenarioLabel(issue.scenarioTag),
    '',
    'h2. 字段',
    `* path: ${issue.fieldPath}`,
    `* stateType: ${issue.stateType}`,
    `* issueType: ${issue.issueType}`,
    '',
    'h2. 差异',
    `* old: ${ev.oldLabel ?? ev.oldValue ?? '—'}`,
    `* new: ${ev.newLabel ?? ev.newValue ?? '—'}`,
    '',
    'h2. 证据',
    `* Epoch: #${ev.epochId ?? '—'}`,
    `* Route: ${ev.route || '—'}`,
    `* Profile: ${ev.profile || '—'}`,
    `* Trigger: ${ev.trigger || '—'}`,
    `* Occurrence: ${issue.occurrenceCount ?? 1}`,
    '',
    'h2. StateScope',
    `* fingerprint: ${issue.fingerprint}`,
    `* localId: ${issue.id}`,
    '',
    '_Created by StateScope Chrome Extension_'
  ].join('\n');
}

async function jiraRequest(credentials, path, options = {}) {
  const base = credentials.baseUrl.replace(/\/$/, '');
  const url = `${base}${path}`;
  const headers = {
    Authorization: `Basic ${basicAuth(credentials.email, credentials.apiToken)}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.errorMessages?.join('; ') || data?.errors ? JSON.stringify(data.errors) : text || response.statusText;
    throw new Error(message || `Jira HTTP ${response.status}`);
  }

  return data;
}

export async function syncIssueToJira(credentials, issue) {
  const labels = [...new Set([...(credentials.labels || []), ...(issue.labels || [])])];
  const fields = {
    project: { key: credentials.projectKey },
    summary: issue.title,
    description: buildDescription(issue),
    issuetype: { name: credentials.issueType || 'Bug' },
    labels
  };

  if (issue.jira?.key) {
    await jiraRequest(credentials, `/rest/api/2/issue/${issue.jira.key}`, {
      method: 'PUT',
      body: { fields: { summary: fields.summary, description: fields.description, labels: fields.labels } }
    });
    await jiraRequest(credentials, `/rest/api/2/issue/${issue.jira.key}/comment`, {
      method: 'POST',
      body: { body: `StateScope 更新证据 · Epoch #${issue.lastEvidence?.epochId ?? '—'} · occurrence ${issue.occurrenceCount}` }
    });
    return {
      key: issue.jira.key,
      url: `${credentials.baseUrl.replace(/\/$/, '')}/browse/${issue.jira.key}`,
      syncStatus: 'synced'
    };
  }

  const created = await jiraRequest(credentials, '/rest/api/2/issue', {
    method: 'POST',
    body: { fields }
  });

  return {
    key: created.key,
    url: `${credentials.baseUrl.replace(/\/$/, '')}/browse/${created.key}`,
    syncStatus: 'synced'
  };
}

export async function testJiraConnection(credentials) {
  await jiraRequest(credentials, '/rest/api/2/myself');
  return true;
}

export function exportIssuesMarkdown(issues) {
  return issues
    .map((issue) => {
      const safe = sanitizeIssueForExport(issue);
      return `## ${safe.title}\n\n- fingerprint: ${safe.fingerprint}\n- status: ${safe.status}\n- scenario: ${safe.scenarioTag}\n\n${buildDescription(safe)}\n`;
    })
    .join('\n---\n\n');
}
