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
    await storageSet(JIRA_TOKEN_KEY, null);
    return false;
  }
  await storageSet(JIRA_TOKEN_KEY, { apiToken: String(apiToken) });
  return true;
}

export async function loadJiraToken() {
  const saved = await storageGet(JIRA_TOKEN_KEY);
  return saved?.apiToken || '';
}

export async function clearJiraToken() {
  await storageSet(JIRA_TOKEN_KEY, null);
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
