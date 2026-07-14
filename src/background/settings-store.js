const SETTINGS_KEY = 'ss:settings:v1';
const JIRA_TOKEN_KEY = 'ss:jira:token:v1';

export function defaultSettings() {
  return {
    autoCollectIssues: true,
    jira: {
      enabled: false,
      autoSync: false,
      baseUrl: '',
      projectKey: '',
      issueType: 'Bug',
      email: '',
      labels: ['StateScope', '状态迁移']
    }
  };
}

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

function sessionGet(key) {
  return new Promise((resolve) => {
    chrome.storage.session.get(key, (result) => resolve(result[key]));
  });
}

function sessionSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.session.set({ [key]: value }, resolve);
  });
}

function sessionRemove(key) {
  return new Promise((resolve) => {
    chrome.storage.session.remove(key, resolve);
  });
}

function localRemove(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, resolve);
  });
}

let migrationDone = false;

async function migrateTokenToSession() {
  if (migrationDone) {
    return;
  }
  migrationDone = true;
  const legacy = await storageGet(JIRA_TOKEN_KEY);
  if (legacy?.apiToken) {
    await sessionSet(JIRA_TOKEN_KEY, { apiToken: legacy.apiToken });
    await localRemove(JIRA_TOKEN_KEY);
  }
}

export async function loadSettings() {
  const saved = await storageGet(SETTINGS_KEY);
  return { ...defaultSettings(), ...(saved || {}) };
}

export async function saveSettings(partial) {
  const current = await loadSettings();
  const next = {
    ...current,
    ...partial,
    jira: {
      ...current.jira,
      ...(partial?.jira || {})
    }
  };
  delete next.jira.apiToken;
  delete next.jira.hasToken;
  await storageSet(SETTINGS_KEY, next);
  return next;
}

export async function saveJiraToken(apiToken) {
  if (!apiToken) {
    await sessionRemove(JIRA_TOKEN_KEY);
    return false;
  }
  await sessionSet(JIRA_TOKEN_KEY, { apiToken: String(apiToken) });
  await localRemove(JIRA_TOKEN_KEY);
  return true;
}

export async function loadJiraToken() {
  await migrateTokenToSession();
  const saved = await sessionGet(JIRA_TOKEN_KEY);
  return saved?.apiToken || '';
}

export async function clearJiraToken() {
  await sessionRemove(JIRA_TOKEN_KEY);
  await localRemove(JIRA_TOKEN_KEY);
}

export async function getSettingsForPanel() {
  const settings = await loadSettings();
  const token = await loadJiraToken();
  return {
    autoCollectIssues: settings.autoCollectIssues !== false,
    jira: {
      enabled: !!settings.jira?.enabled,
      autoSync: !!settings.jira?.autoSync,
      baseUrl: settings.jira?.baseUrl || '',
      projectKey: settings.jira?.projectKey || '',
      issueType: settings.jira?.issueType || 'Bug',
      email: settings.jira?.email || '',
      labels: settings.jira?.labels || ['StateScope', '状态迁移'],
      hasToken: !!token
    }
  };
}

export async function getJiraCredentials() {
  const settings = await loadSettings();
  const apiToken = await loadJiraToken();
  if (!settings.jira?.enabled || !apiToken || !settings.jira.baseUrl || !settings.jira.projectKey) {
    return null;
  }
  return {
    ...settings.jira,
    apiToken
  };
}
