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
import { getBundledScenarioPack, normalizeScenarioPack } from '../shared/scenario-catalog.js';
import {
  clearJiraToken,
  getJiraCredentials,
  getSettingsForPanel,
  loadSettings,
  saveJiraToken,
  saveSettings
} from './settings-store.js';
import { normalizeEpochId, slimEpochForStorage } from '../shared/slim-epoch.js';

const MAX_EPOCHS = 30;
const tabStore = new Map();
const GOODS_ISSUE_L3_VERSION = '2026-06-29-l3-v1';

function resolveBundledScenarioPack(boName) {
  // 仅 GoodsIssue 有内置包；其它 BO 禁止跨 BO fallback，须上传领域 SSOT
  return getBundledScenarioPack(boName);
}

function hasMatchingScenarioCatalog(state, boName) {
  const pack = state.scenarioCatalogPack;
  if (!pack?.scenarios?.length) {
    return false;
  }
  if (boName && pack.boName && pack.boName !== boName) {
    return false;
  }
  if (pack.boName === 'GoodsIssue' && pack.version === GOODS_ISSUE_L3_VERSION) {
    return true;
  }
  // 用户上传的领域 SSOT / 工具 L3：同 boName 且有场景即视为已就绪
  return !!pack.boName && pack.scenarios.length > 0;
}

function ensureScenarioCatalog(state, boName, { force = false } = {}) {
  if (!state) {
    return { ok: false, error: '无 tab 状态' };
  }

  const targetBo = boName || state.runtime?.meta?.boName || '';
  if (!force && hasMatchingScenarioCatalog(state, targetBo)) {
    return {
      ok: true,
      applied: false,
      reason: 'already-has-catalog',
      boName: state.scenarioCatalogPack.boName,
      version: state.scenarioCatalogPack.version,
      scenarioCount: state.scenarioCatalogPack.scenarios.length,
      catalog: state.scenarioCatalogPack,
      scenarioReport: state.scenarioReport
    };
  }

  if (!targetBo) {
    return { ok: false, error: '无 boName，无法选择场景包', needsUpload: true };
  }

  const bundled = resolveBundledScenarioPack(targetBo);
  if (!bundled) {
    if (state.scenarioCatalogPack?.boName === targetBo && state.scenarioCatalogPack.scenarios?.length) {
      return {
        ok: true,
        applied: false,
        reason: 'uploaded-catalog',
        boName: state.scenarioCatalogPack.boName,
        version: state.scenarioCatalogPack.version,
        scenarioCount: state.scenarioCatalogPack.scenarios.length,
        catalog: state.scenarioCatalogPack,
        scenarioReport: state.scenarioReport
      };
    }
    // 清空错误 BO 的旧包，避免 OutsourceIssue 页残留销货单 checklist
    if (force || (state.scenarioCatalogPack?.boName && state.scenarioCatalogPack.boName !== targetBo)) {
      state.scenarioCatalogPack = null;
      state.scenarioReport = emptyScenarioReport(null);
      state.updatedAt = Date.now();
    }
    return {
      ok: false,
      error: `${targetBo} 无内置场景包，请上传领域 *.scenarios.v1.json（SSOT）`,
      needsUpload: true,
      boName: targetBo
    };
  }

  state.scenarioCatalogPack = bundled;
  state.scenarioReport = emptyScenarioReport(bundled);
  state.updatedAt = Date.now();
  return {
    ok: true,
    applied: true,
    boName: bundled.boName,
    version: bundled.version,
    scenarioCount: bundled.scenarios.length,
    catalog: bundled,
    scenarioReport: state.scenarioReport
  };
}

function emptyTabState(catalogPack) {
  const pack = catalogPack || null;
  return {
    runtime: null,
    epochs: [],
    selectedEpochId: null,
    cutoverReport: emptyCutoverReport(),
    scenarioCatalogPack: pack,
    scenarioReport: emptyScenarioReport(pack),
    scenarioIgnoreEpochsBefore: 0,
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
  let scenarioReport = emptyScenarioReport(state.scenarioCatalogPack);
  const ignoreBefore = state.scenarioIgnoreEpochsBefore || state.scenarioReport?.ignoreEpochsBefore || 0;
  scenarioReport.ignoreEpochsBefore = ignoreBefore;
  for (const epoch of [...state.epochs].reverse()) {
    cutoverReport = accumulateCutoverReport(cutoverReport, epoch);
    scenarioReport = accumulateScenarioReport(scenarioReport, epoch);
  }
  state.cutoverReport = cutoverReport;
  state.scenarioReport = scenarioReport;
  state.scenarioIgnoreEpochsBefore = ignoreBefore;
}

function epochCountsTowardScenario(epoch, ignoreBefore) {
  if (!epoch?.scenarioTag) {
    return false;
  }
  if (ignoreBefore > 0 && (epoch.startedAt || 0) <= ignoreBefore) {
    return false;
  }
  return true;
}

/** 按 tag 对齐：页面/SW 已有带 scenarioTag 的轮次，但场景累计偏少时重放 */
function healScenarioReportFromEpochs(state) {
  if (!state?.scenarioCatalogPack || !state.epochs?.length) {
    return false;
  }
  const scenarios = state.scenarioReport?.scenarios || {};
  if (!Object.keys(scenarios).length) {
    rebuildDerivedReports(state);
    return true;
  }

  const ignoreBefore = state.scenarioIgnoreEpochsBefore || state.scenarioReport?.ignoreEpochsBefore || 0;
  const tagCounts = {};
  for (const epoch of state.epochs) {
    if (!epochCountsTowardScenario(epoch, ignoreBefore)) {
      continue;
    }
    const tag = epoch.scenarioTag;
    if (!scenarios[tag]) {
      continue;
    }
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }

  const needsRebuild = Object.entries(tagCounts).some(
    ([tag, count]) => (scenarios[tag]?.epochCount || 0) < count
  );
  if (!needsRebuild) {
    return false;
  }

  rebuildDerivedReports(state);
  return true;
}

async function bulkSyncTabState(tabId, { runtime, epochs }) {
  const state = getTabState(tabId);
  if (runtime) {
    state.runtime = runtime;
  }
  if (Array.isArray(epochs) && epochs.length) {
    const merged = new Map(state.epochs.map((item) => [String(normalizeEpochId(item.id)), item]));
    for (const epoch of epochs) {
      if (epoch?.id != null) {
        const slim = slimEpochForStorage(epoch);
        merged.set(String(slim.id), slim);
      }
    }
    state.epochs = [...merged.values()]
      .sort((a, b) => (b.startedAt || b.id) - (a.startedAt || a.id))
      .slice(0, MAX_EPOCHS);
    const latestId = state.epochs[0]?.id ?? null;
    const selectedStillExists =
      state.selectedEpochId != null &&
      state.epochs.some((item) => String(item.id) === String(state.selectedEpochId));
    if (latestId != null && !selectedStillExists) {
      state.selectedEpochId = latestId;
    }
    rebuildDerivedReports(state);
  }
  state.updatedAt = Date.now();
  return state;
}

async function pushEpoch(tabId, payload) {
  const state = getTabState(tabId);
  const slim = slimEpochForStorage(payload);
  const slimIdKey = String(slim.id);
  const prevLatestId = state.epochs[0]?.id ?? null;
  const wasFollowingLatest =
    state.selectedEpochId == null || String(state.selectedEpochId) === String(prevLatestId);
  state.epochs = [slim, ...state.epochs.filter((item) => String(item.id) !== slimIdKey)].slice(
    0,
    MAX_EPOCHS
  );
  if (wasFollowingLatest) {
    state.selectedEpochId = slim.id;
  }
  state.cutoverReport = accumulateCutoverReport(state.cutoverReport, slim);
  state.scenarioReport = accumulateScenarioReport(state.scenarioReport, slim);
  state.updatedAt = Date.now();

  const settings = await loadSettings();
  // Issue 采集需要 diffs：用原始 payload，SW 只存 slim
  const upserted = await collectIssuesFromEpoch(payload, tabId, settings);

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

function notifyPanelStateUpdated(tabId) {
  if (tabId == null) {
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: 'SS_STATE_UPDATED', tabId }).catch(() => {});
  } catch {
    // DevTools panel 未打开或 port 已断开 — 静默忽略
  }
}

const INTERNAL_ONLY_TYPES = new Set([
  'SS_SAVE_SETTINGS',
  'SS_SAVE_JIRA_TOKEN',
  'SS_CLEAR_JIRA_TOKEN',
  'SS_TEST_JIRA',
  'SS_BATCH_SYNC_JIRA',
  'SS_DELETE_ISSUE',
  'SS_UPDATE_ISSUE',
  'SS_PROMOTE_ISSUE'
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (INTERNAL_ONLY_TYPES.has(message.type) && sender.tab) {
    sendResponse({ ok: false, error: '敏感操作仅限扩展内部页面' });
    return true;
  }

  const tabId = sender.tab?.id ?? message.tabId;

  const run = async () => {
    if (message.type === 'SS_EPOCH' && sender.tab?.id != null) {
      await pushEpoch(sender.tab.id, message.payload);
      notifyPanelStateUpdated(sender.tab.id);
      return { ok: true };
    }

    if (message.type === 'SS_RUNTIME' && sender.tab?.id != null) {
      const state = getTabState(sender.tab.id);
      state.runtime = message.payload;
      const boName = message.payload?.meta?.boName;

      const pageCatalog = message.payload?.scenarioCatalogPack;
      if (pageCatalog?.scenarios?.length && pageCatalog.boName) {
        const hasCatalog = hasMatchingScenarioCatalog(state, pageCatalog.boName);
        if (!hasCatalog) {
          const pack = normalizeScenarioPack(pageCatalog);
          if (pack) {
            state.scenarioCatalogPack = pack;
            if (state.epochs?.length) {
              rebuildDerivedReports(state);
            } else {
              state.scenarioReport = emptyScenarioReport(pack);
            }
          }
        }
      }

      ensureScenarioCatalog(state, boName);
      state.updatedAt = Date.now();
      notifyPanelStateUpdated(sender.tab.id);
      return { ok: true };
    }

    if (message.type === 'SS_GET_STATE') {
      const targetTabId = message.tabId;
      const state = targetTabId != null ? getTabState(targetTabId) : emptyTabState();
      if (targetTabId != null) {
        ensureScenarioCatalog(state, state.runtime?.meta?.boName);
        healScenarioReportFromEpochs(state);
      }
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
          scenarioCatalogPack: state.scenarioCatalogPack,
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
      notifyPanelStateUpdated(message.tabId);
      return {
        ok: true,
        epochCount: state.epochs.length,
        hasRuntime: !!state.runtime,
        scenarioReport: state.scenarioReport,
        cutoverReport: state.cutoverReport,
        scenarioCatalogPack: state.scenarioCatalogPack
      };
    }

    if (message.type === 'SS_SELECT_EPOCH') {
      const state = getTabState(message.tabId);
      if (state.epochs.some((item) => item.id == message.epochId)) {
        state.selectedEpochId = message.epochId;
      }
      return { ok: true, selectedEpochId: state.selectedEpochId };
    }

    if (message.type === 'SS_RESET_CUTOVER') {
      const state = getTabState(message.tabId);
      state.cutoverReport = emptyCutoverReport();
      state.updatedAt = Date.now();
      notifyPanelStateUpdated(message.tabId);
      return { ok: true };
    }

    if (message.type === 'SS_RESET_SCENARIO_REPORT') {
      const state = getTabState(message.tabId);
      const next = resetScenarioReport(state.scenarioReport, state.scenarioCatalogPack);
      state.scenarioIgnoreEpochsBefore = next.ignoreEpochsBefore || Date.now();
      state.scenarioReport = next;
      state.updatedAt = Date.now();
      notifyPanelStateUpdated(message.tabId);
      return { ok: true, scenarioReport: state.scenarioReport };
    }

    if (message.type === 'SS_BOOTSTRAP_SCENARIO_CATALOG') {
      const state = getTabState(message.tabId);
      const result = ensureScenarioCatalog(state, message.boName, { force: !!message.force });
      if (result.applied) {
        notifyPanelStateUpdated(message.tabId);
      }
      return result;
    }

    if (message.type === 'SS_APPLY_SCENARIO_CATALOG') {
      const state = getTabState(message.tabId);
      const pack = normalizeScenarioPack(message.catalog);
      if (!pack) {
        return { ok: false, error: '无效场景 catalog（需含 scenarios；支持领域 SSOT 或工具 L3）' };
      }
      state.scenarioCatalogPack = pack;
      // 先挂 catalog，再按已有 epochs 重放累计（避免「轮次已产生、场景仍尚未观测」）
      if (state.epochs?.length) {
        rebuildDerivedReports(state);
      } else {
        state.scenarioReport = emptyScenarioReport(pack);
      }
      state.updatedAt = Date.now();
      notifyPanelStateUpdated(message.tabId);
      return {
        ok: true,
        boName: pack.boName,
        version: pack.version,
        scenarioCount: pack.scenarios.length,
        catalog: pack,
        scenarioReport: state.scenarioReport
      };
    }

    if (message.type === 'SS_MARK_SCENARIO') {
      const state = getTabState(message.tabId);
      const result = markScenarioComplete(state.scenarioReport, message.scenarioTag, message.complete !== false);
      if (!result.ok) {
        return result;
      }
      state.updatedAt = Date.now();
      notifyPanelStateUpdated(message.tabId);
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
      notifyPanelStateUpdated(message.tabId);
      return { ok: true, issue };
    }

    if (message.type === 'SS_UPDATE_ISSUE') {
      const issue = await updateIssue(message.fingerprint, message.patch || {});
      notifyPanelStateUpdated(message.tabId);
      return { ok: !!issue, issue };
    }

    if (message.type === 'SS_DELETE_ISSUE') {
      const ok = await deleteIssue(message.fingerprint);
      notifyPanelStateUpdated(message.tabId);
      return { ok };
    }

    if (message.type === 'SS_BATCH_SYNC_JIRA') {
      const result = await syncIssuesBatch(message.fingerprints || []);
      notifyPanelStateUpdated(message.tabId);
      return result;
    }

    if (message.type === 'SS_GET_SETTINGS') {
      return { ok: true, settings: await getSettingsForPanel() };
    }

    if (message.type === 'SS_SAVE_SETTINGS') {
      const settings = await saveSettings(message.settings || {});
      notifyPanelStateUpdated(message.tabId);
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
