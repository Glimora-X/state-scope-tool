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

function hasMatchingScenarioCatalog(state, boName, incomingPack = null) {
  const pack = state.scenarioCatalogPack;
  if (!pack?.scenarios?.length) {
    return false;
  }
  if (boName && pack.boName && pack.boName !== boName) {
    return false;
  }
  if (!incomingPack) {
    // 无对端包时：仅表示「SW 侧已有同 BO 包」，调用方须再用 epoch 决定是否跳过
    return !!pack.boName && pack.scenarios.length > 0;
  }
  const left = normalizeScenarioPack(pack);
  const right = normalizeScenarioPack(incomingPack);
  if (!left?.catalogEpoch || !right?.catalogEpoch) {
    return false;
  }
  // epoch + source 都一致才算匹配（① 覆盖 ② 即使 epoch 相同）
  return left.catalogEpoch === right.catalogEpoch && (left.source || '') === (right.source || '');
}

function ensureScenarioCatalog(state, boName, { force = false } = {}) {
  if (!state) {
    return { ok: false, error: '无 tab 状态' };
  }

  const targetBo = boName || state.runtime?.meta?.boName || '';
  // 禁止「存在即最新」：无传入对账包时，已有同 BO 包也不算最终权威，仅作会话缓存
  if (!force && !targetBo) {
    return { ok: false, error: '无 boName，无法选择场景包', needsUpload: true };
  }

  if (!targetBo) {
    return { ok: false, error: '无 boName，无法选择场景包', needsUpload: true };
  }

  const bundled = resolveBundledScenarioPack(targetBo);
  if (!bundled) {
    if (
      !force &&
      state.scenarioCatalogPack?.boName === targetBo &&
      state.scenarioCatalogPack.scenarios?.length &&
      state.scenarioCatalogPack.catalogEpoch
    ) {
      return {
        ok: true,
        applied: false,
        reason: 'session-cache',
        boName: state.scenarioCatalogPack.boName,
        version: state.scenarioCatalogPack.version,
        catalogEpoch: state.scenarioCatalogPack.catalogEpoch,
        source: state.scenarioCatalogPack.source || '',
        scenarioCount: state.scenarioCatalogPack.scenarios.length,
        catalog: state.scenarioCatalogPack,
        scenarioReport: state.scenarioReport,
        // 非内置 BO：仍提示可由页面 ① 覆盖
        needsPageAuthority: true
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
      error: `${targetBo} 无内置场景包，请等待领域自注册或上传 *.scenarios.v1.json`,
      needsUpload: true,
      boName: targetBo
    };
  }

  const existing = state.scenarioCatalogPack;
  if (
    !force &&
    existing?.boName === bundled.boName &&
    existing?.catalogEpoch &&
    existing.catalogEpoch === bundled.catalogEpoch &&
    (existing.source || '') === (bundled.source || '')
  ) {
    return {
      ok: true,
      applied: false,
      reason: 'epoch-matched',
      boName: existing.boName,
      version: existing.version,
      catalogEpoch: existing.catalogEpoch,
      source: existing.source || '',
      scenarioCount: existing.scenarios.length,
      catalog: existing,
      scenarioReport: state.scenarioReport
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
    catalogEpoch: bundled.catalogEpoch,
    source: bundled.source || '',
    scenarioCount: bundled.scenarios.length,
    catalog: bundled,
    scenarioReport: state.scenarioReport
  };
}

/** 仅修正存量 os-s01：去掉空白单不可达的明细 {uuid} watch，并重放累计 */
function migrateOsS01BlankWatchFields(state) {
  const pack = state?.scenarioCatalogPack;
  const meta = pack?.scenarios?.find((item) => item?.tag === 'os-s01');
  if (!meta?.watchFields?.some((w) => String(w?.path || '').includes('{uuid}'))) {
    return false;
  }
  meta.watchFields = meta.watchFields.filter((w) => !String(w?.path || '').includes('{uuid}'));
  const record = state.scenarioReport?.scenarios?.['os-s01'];
  if (record) {
    record.watchFields = meta.watchFields;
  }
  if (state.epochs?.length) {
    rebuildDerivedReports(state);
  } else if (record) {
    record.allowlistFieldCount = meta.watchFields.length;
    record.unobservedFields = Math.max(0, record.allowlistFieldCount - (record.readyFields || 0));
  }
  state.updatedAt = Date.now();
  return true;
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
  const fallbackTag =
    state.scenarioCatalogPack?.scenarios?.length ?
      [...state.scenarioCatalogPack.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag || ''
    : '';
  for (const epoch of [...state.epochs].reverse()) {
    cutoverReport = accumulateCutoverReport(cutoverReport, epoch);
    const tagged =
      epoch?.scenarioTag || !fallbackTag ?
        epoch
      : { ...epoch, scenarioTag: fallbackTag };
    scenarioReport = accumulateScenarioReport(scenarioReport, tagged);
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

      // 完整 scenarios 包只认 Panel SS_APPLY；SS_RUNTIME 只带摘要 hint，避免每轮 Epoch 重建
      const pageCatalog =
        message.payload?.scenarioCatalogPack?.scenarios?.length ?
          message.payload.scenarioCatalogPack
        : null;
      if (pageCatalog?.boName) {
        const pack = normalizeScenarioPack(pageCatalog);
        if (pack) {
          const matched = hasMatchingScenarioCatalog(state, pageCatalog.boName, pack);
          // ① window-registry 即使 epoch 相同也覆盖 source；epoch 不同必须覆盖
          const forceAuthority =
            pack.source === 'window-registry' && state.scenarioCatalogPack?.source !== 'window-registry';
          if (!matched || forceAuthority) {
            const prevEpoch = state.scenarioCatalogPack?.catalogEpoch || '';
            state.scenarioCatalogPack = pack;
            if (prevEpoch && prevEpoch !== pack.catalogEpoch) {
              // catalogEpoch 变化：重建签字骨架，不继承旧进度
              state.scenarioReport = emptyScenarioReport(pack);
            } else if (state.epochs?.length) {
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
        migrateOsS01BlankWatchFields(state);
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

    if (message.type === 'SS_CLEAR_CACHE') {
      const state = getTabState(message.tabId);
      const fresh = emptyTabState(state.scenarioCatalogPack);
      fresh.runtime = state.runtime;
      tabStore.set(message.tabId, fresh);
      notifyPanelStateUpdated(message.tabId);
      return { ok: true };
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
      const prevEpoch = state.scenarioCatalogPack?.catalogEpoch || '';
      state.scenarioCatalogPack = pack;
      // catalogEpoch 变化：重建签字骨架，禁止跨 epoch 继承 PASS/BLOCK
      if (prevEpoch && prevEpoch !== pack.catalogEpoch) {
        state.scenarioReport = emptyScenarioReport(pack);
      } else if (state.epochs?.length) {
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
        catalogEpoch: pack.catalogEpoch,
        source: pack.source || '',
        scenarioCount: pack.scenarios.length,
        catalog: pack,
        scenarioReport: state.scenarioReport
      };
    }

    if (message.type === 'SS_MARK_SCENARIO') {
      const state = getTabState(message.tabId);
      ensureScenarioCatalog(state, state.runtime?.meta?.boName || state.scenarioCatalogPack?.boName);
      migrateOsS01BlankWatchFields(state);

      // Panel 可能已 hydrate 出场景列表，但 SW 丢 catalog/report → 补齐后再签字
      if (!state.scenarioReport?.scenarios?.[message.scenarioTag] && state.scenarioCatalogPack?.scenarios?.length) {
        if (state.epochs?.length) {
          rebuildDerivedReports(state);
        } else {
          state.scenarioReport = emptyScenarioReport(state.scenarioCatalogPack);
        }
      }

      const result = markScenarioComplete(state.scenarioReport, message.scenarioTag, message.complete !== false);
      if (!result.ok) {
        if (result.error === '未知场景' && !state.scenarioCatalogPack?.scenarios?.length) {
          return {
            ok: false,
            error: '场景包未同步到后台，请先上传领域 SSOT（或点「加载内置场景」）后再签字',
            needsUpload: true
          };
        }
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
  ensureContextMenus();
});

const MENU_ROOT = 'ss-root';
const MENU_ENABLE = 'ss-enable-debug';
const MENU_HINT = 'ss-open-hint';

function ensureContextMenus() {
  if (!chrome.contextMenus?.create) {
    return;
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ROOT,
      title: 'StateScope',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: MENU_ENABLE,
      parentId: MENU_ROOT,
      title: '启用调试并刷新本页',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: MENU_HINT,
      parentId: MENU_ROOT,
      title: '如何打开 StateScope 面板…',
      contexts: ['page', 'frame']
    });
  });
}

// SW 冷启动后补注册右键菜单
ensureContextMenus();

chrome.contextMenus?.onClicked?.addListener(async (info, tab) => {
  if (!tab?.id) {
    return;
  }
  if (info.menuItemId === MENU_HINT) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/guide/open-panel.html') });
    return;
  }
  if (info.menuItemId !== MENU_ENABLE) {
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        try {
          localStorage.setItem('bizDebug', 'true');
          window.bizDebug = true;
        } catch {
          // ignore
        }
        location.reload();
      }
    });
  } catch (error) {
    console.warn('[StateScope] enable debug failed:', error?.message || error);
  }
});
