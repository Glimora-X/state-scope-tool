import { accumulateCutoverReport, emptyCutoverReport } from './cutover-accumulator.js';
import { collectIssuesFromEpoch, promoteAnomalyToIssue } from './issue-collector.js';
import { deleteIssue, listIssues, updateIssue } from './issue-store.js';
import { exportIssuesMarkdown, syncIssueToJira, testJiraConnection } from './jira-client.js';
import {
  accumulateScenarioReport,
  emptyScenarioReport,
  exportScenarioReportCsv,
  exportScenarioReportJson,
  markScenarioComplete,
  resetScenarioReport
} from './scenario-report-accumulator.js';
import {
  clearJiraToken,
  getJiraCredentials,
  getSettingsForPanel,
  loadSettings,
  saveJiraToken,
  saveSettings
} from './settings-store.js';
import { slimEpochForStorage } from '../shared/slim-epoch.js';

const MAX_EPOCHS = 30;
const tabStore = new Map();

function emptyTabState() {
  return {
    runtime: null,
    epochs: [],
    selectedEpochId: null,
    cutoverReport: emptyCutoverReport(),
    scenarioReport: emptyScenarioReport(),
    updatedAt: 0
  };
}

function getTabState(tabId) {
  if (!tabStore.has(tabId)) {
    tabStore.set(tabId, emptyTabState());
  }
  return tabStore.get(tabId);
}

function rebuildDerivedReports(state) {
  let cutoverReport = emptyCutoverReport();
  let scenarioReport = emptyScenarioReport();
  for (const epoch of [...state.epochs].reverse()) {
    cutoverReport = accumulateCutoverReport(cutoverReport, epoch);
    scenarioReport = accumulateScenarioReport(scenarioReport, epoch);
  }
  state.cutoverReport = cutoverReport;
  state.scenarioReport = scenarioReport;
}

async function bulkSyncTabState(tabId, { runtime, epochs }) {
  const state = getTabState(tabId);
  if (runtime) {
    state.runtime = runtime;
  }
  if (Array.isArray(epochs) && epochs.length) {
    const merged = new Map(state.epochs.map((item) => [item.id, item]));
    for (const epoch of epochs) {
      if (epoch?.id != null) {
        merged.set(epoch.id, slimEpochForStorage(epoch));
      }
    }
    state.epochs = [...merged.values()]
      .sort((a, b) => (b.startedAt || b.id) - (a.startedAt || a.id))
      .slice(0, MAX_EPOCHS);
    state.selectedEpochId = state.epochs[0]?.id ?? state.selectedEpochId;
    rebuildDerivedReports(state);
  }
  state.updatedAt = Date.now();
  return state;
}

async function pushEpoch(tabId, payload) {
  const state = getTabState(tabId);
  const slim = slimEpochForStorage(payload);
  state.epochs = [slim, ...state.epochs.filter((item) => item.id !== slim.id)].slice(0, MAX_EPOCHS);
  state.selectedEpochId = slim.id;
  state.cutoverReport = accumulateCutoverReport(state.cutoverReport, slim);
  state.scenarioReport = accumulateScenarioReport(state.scenarioReport, slim);
  state.updatedAt = Date.now();

  const settings = await loadSettings();
  const upserted = await collectIssuesFromEpoch(slim, tabId, settings);

  if (settings.jira?.enabled && settings.jira?.autoSync && upserted.length) {
    await syncIssuesBatch(upserted.map((item) => item.fingerprint));
  }
}

async function syncIssuesBatch(fingerprints) {
  const creds = await getJiraCredentials();
  if (!creds) {
    return { ok: false, error: 'Jira 未配置或缺少 token' };
  }

  const results = [];
  for (const fingerprint of fingerprints) {
    const issues = await listIssues();
    const issue = issues.find((item) => item.fingerprint === fingerprint);
    if (!issue) {
      continue;
    }
    try {
      const remote = await syncIssueToJira(creds, issue);
      const updated = await updateIssue(fingerprint, {
        jira: {
          ...remote,
          lastSyncAt: Date.now(),
          lastError: ''
        }
      });
      results.push({ fingerprint, ok: true, key: remote.key });
    } catch (error) {
      await updateIssue(fingerprint, {
        jira: {
          syncStatus: 'failed',
          lastError: error.message,
          lastSyncAt: Date.now()
        }
      });
      results.push({ fingerprint, ok: false, error: error.message });
    }
  }

  return { ok: true, results };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStore.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? message.tabId;

  const run = async () => {
    if (message.type === 'SS_EPOCH' && sender.tab?.id != null) {
      await pushEpoch(sender.tab.id, message.payload);
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: sender.tab.id }).catch(() => {});
      return { ok: true };
    }

    if (message.type === 'SS_RUNTIME' && sender.tab?.id != null) {
      const state = getTabState(sender.tab.id);
      state.runtime = message.payload;
      state.updatedAt = Date.now();
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: sender.tab.id }).catch(() => {});
      return { ok: true };
    }

    if (message.type === 'SS_GET_STATE') {
      const targetTabId = message.tabId;
      const state = targetTabId != null ? getTabState(targetTabId) : emptyTabState();
      const issues = await listIssues();
      const settings = await getSettingsForPanel();
      return {
        ok: true,
        state: {
          runtime: state.runtime,
          epochs: state.epochs,
          selectedEpochId: state.selectedEpochId,
          cutoverReport: state.cutoverReport,
          scenarioReport: state.scenarioReport,
          issues,
          settings,
          updatedAt: state.updatedAt
        }
      };
    }

    if (message.type === 'SS_BULK_SYNC' && message.tabId != null) {
      const state = await bulkSyncTabState(message.tabId, {
        runtime: message.runtime,
        epochs: message.epochs
      });
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: message.tabId }).catch(() => {});
      return {
        ok: true,
        epochCount: state.epochs.length,
        hasRuntime: !!state.runtime
      };
    }

    if (message.type === 'SS_SELECT_EPOCH') {
      const state = getTabState(message.tabId);
      if (state.epochs.some((item) => item.id === message.epochId)) {
        state.selectedEpochId = message.epochId;
      }
      return { ok: true, selectedEpochId: state.selectedEpochId };
    }

    if (message.type === 'SS_RESET_CUTOVER') {
      const state = getTabState(message.tabId);
      state.cutoverReport = emptyCutoverReport();
      state.updatedAt = Date.now();
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: message.tabId }).catch(() => {});
      return { ok: true };
    }

    if (message.type === 'SS_RESET_SCENARIO_REPORT') {
      const state = getTabState(message.tabId);
      state.scenarioReport = resetScenarioReport();
      state.updatedAt = Date.now();
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: message.tabId }).catch(() => {});
      return { ok: true };
    }

    if (message.type === 'SS_MARK_SCENARIO') {
      const state = getTabState(message.tabId);
      const result = markScenarioComplete(state.scenarioReport, message.scenarioTag, message.complete !== false);
      if (!result.ok) {
        return result;
      }
      state.updatedAt = Date.now();
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: message.tabId }).catch(() => {});
      return result;
    }

    if (message.type === 'SS_EXPORT_SCENARIO_REPORT') {
      const state = getTabState(message.tabId);
      const report = state.scenarioReport || emptyScenarioReport();
      if (message.format === 'csv') {
        return { ok: true, csv: exportScenarioReportCsv(report) };
      }
      return {
        ok: true,
        json: exportScenarioReportJson(report, {
          route: state.runtime?.meta?.route,
          profile: state.runtime?.meta?.profile
        })
      };
    }

    if (message.type === 'SS_PROMOTE_ISSUE') {
      const state = getTabState(message.tabId);
      const epoch = state.epochs.find((item) => item.id === message.epochId) || state.epochs[0];
      if (!epoch) {
        return { ok: false, error: '无 Epoch 数据' };
      }
      const issue = await promoteAnomalyToIssue(epoch, message.tabId, message.anomaly, message.scenarioTag);
      if (message.autoSyncJira) {
        await syncIssuesBatch([issue.fingerprint]);
      }
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: message.tabId }).catch(() => {});
      return { ok: true, issue };
    }

    if (message.type === 'SS_UPDATE_ISSUE') {
      const issue = await updateIssue(message.fingerprint, message.patch || {});
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: message.tabId }).catch(() => {});
      return { ok: !!issue, issue };
    }

    if (message.type === 'SS_DELETE_ISSUE') {
      const ok = await deleteIssue(message.fingerprint);
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: message.tabId }).catch(() => {});
      return { ok };
    }

    if (message.type === 'SS_BATCH_SYNC_JIRA') {
      const result = await syncIssuesBatch(message.fingerprints || []);
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: message.tabId }).catch(() => {});
      return result;
    }

    if (message.type === 'SS_GET_SETTINGS') {
      return { ok: true, settings: await getSettingsForPanel() };
    }

    if (message.type === 'SS_SAVE_SETTINGS') {
      const settings = await saveSettings(message.settings || {});
      chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId: message.tabId }).catch(() => {});
      return { ok: true, settings: await getSettingsForPanel() };
    }

    if (message.type === 'SS_SAVE_JIRA_TOKEN') {
      await saveJiraToken(message.apiToken || '');
      return { ok: true, settings: await getSettingsForPanel() };
    }

    if (message.type === 'SS_CLEAR_JIRA_TOKEN') {
      await clearJiraToken();
      return { ok: true, settings: await getSettingsForPanel() };
    }

    if (message.type === 'SS_TEST_JIRA') {
      const creds = await getJiraCredentials();
      if (!creds) {
        return { ok: false, error: '请先填写 Jira 配置并保存 Token' };
      }
      await testJiraConnection(creds);
      return { ok: true };
    }

    if (message.type === 'SS_EXPORT_ISSUES_MD') {
      const issues = await listIssues();
      const selected = message.fingerprints?.length ?
          issues.filter((item) => message.fingerprints.includes(item.fingerprint))
        : issues;
      return { ok: true, markdown: exportIssuesMarkdown(selected) };
    }

    return null;
  };

  run()
    .then((result) => {
      if (result != null) {
        sendResponse(result);
      }
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[StateScope] extension installed (P1.5 scenario regression mode)');
});
