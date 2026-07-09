const ui = {
  tab: 'overview',
  selectedEpochId: null,
  /** true = 跟随最新 Epoch；用户点选历史条目后变为 false */
  epochFollowLatest: true,
  expanded: {
    changedSet: false,
    main: false,
    detail: false
  },
  showPaths: false,
  detailAllColumns: false,
  diffOnlyMismatch: true,
  diffSearch: '',
  diffFocusPath: null,
  pageSettings: null,
  settingsMessage: '',
  lastSyncedBoName: null,
  lastSyncedScenarioCatalogKey: null,
  allowlistBinding: null,
  scenarioCatalog: null,
  scenarioTag: '',
  issueStatusFilter: '',
  issueSyncFilter: '',
  selectedIssueFps: null,
  selectedScenarioTag: ''
};

const DEBUG_KEYS = [
  { key: 'bizDebug', label: 'bizDebug', desc: '必须，激活 StateScope' },
  { key: 'stateScopeVerbose', label: 'stateScopeVerbose', desc: '输出完整 oldSnap/newSnap' },
  { key: 'stateScopeDebug', label: 'stateScopeDebug', desc: '写入 __StateScope__.getLastEpoch()' }
];

const PROFILE_OPTIONS = [
  { value: 'auto', label: 'auto（自动识别）', desc: '优先运行时信号，hybrid 时用 boName 默认映射' },
  { value: 'traditional', label: 'traditional（系统单据）', desc: 'StateCollector + FormController.refreshView' },
  { value: 'lowcode', label: 'lowcode（MDF 低代码）', desc: 'getDisable 终值 vs shadowStore / statePatches' }
];

let tabId = null;
let appState = null;
let dataSource = 'background';
let lastRefreshFingerprint = '';
let refreshInFlight = false;
let pendingRefresh = false;
let lastPageSyncEpochCount = 0;
let lastSyncedLatestEpochId = null;
let refreshTimerId = null;
let runtimeMessageFailures = 0;
const MAX_RUNTIME_MESSAGE_FAILURES = 3;
const PANEL_REFRESH_MS = 4000;

async function safeRuntimeMessage(message) {
  if (runtimeMessageFailures >= MAX_RUNTIME_MESSAGE_FAILURES) {
    return null;
  }
  try {
    if (!chrome.runtime?.id) {
      runtimeMessageFailures = MAX_RUNTIME_MESSAGE_FAILURES;
      return null;
    }
    const response = await chrome.runtime.sendMessage(message);
    runtimeMessageFailures = 0;
    return response;
  } catch {
    runtimeMessageFailures += 1;
    return null;
  }
}

const GOODS_ISSUE_L3_VERSION = '2026-06-29-l3-v1';

function seedScenarioFieldRows(record) {
  if (!record?.watchFields?.length) {
    return record;
  }
  const map = new Map((record.fields || []).map((item) => [item.fieldId, item]));
  for (const watch of record.watchFields) {
    if (!watch?.path) {
      continue;
    }
    const stateType = watch.stateType || 'disabled';
    const fieldId = `${watch.path}::${stateType}`;
    if (map.has(fieldId)) {
      continue;
    }
    map.set(fieldId, {
      fieldId,
      path: watch.path,
      stateType,
      configKey: '',
      epochCount: 0,
      logicMismatchCount: 0,
      lastSeverity: 'unobserved',
      lastEpochId: null,
      scenarioReady: false,
      blockReason: '尚未观测'
    });
  }
  record.fields = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  record.allowlistFieldCount = record.signOffMode === 'manual' ? 0 : record.watchFields.length;
  record.unobservedFields = Math.max(0, record.allowlistFieldCount - (record.readyFields || 0));
  return record;
}

function isLegacyScenarioReport(report) {
  if (!report?.scenarios) {
    return true;
  }
  const tags = Object.keys(report.scenarios);
  if (!tags.length) {
    return true;
  }
  if (report.catalogVersion === GOODS_ISSUE_L3_VERSION && tags.length >= 15) {
    return false;
  }
  // 用户上传的领域 SSOT（归一化后 tag 来自 OI-S01 等）或工具 L3
  if (tags.some((tag) => tag.startsWith('gi-') || tag.startsWith('oi-') || /^oi-s\d+/i.test(tag) || /^s\d+$/i.test(tag))) {
    return false;
  }
  if (report.catalogVersion && tags.length >= 1 && !['new', 'edit', 'view'].includes(tags[0])) {
    return false;
  }
  return tags.length <= 10 && tags.includes('new');
}

function buildScenarioRecordFromMeta(meta, existing) {
  if (existing) {
    const merged = {
      ...existing,
      tag: meta.tag,
      order: meta.order ?? existing.order ?? 0,
      label: meta.label || existing.label || meta.tag,
      group: meta.group || existing.group || '',
      checkpoint: meta.checkpoint || existing.checkpoint || '',
      signOffMode: meta.signOffMode === 'manual' ? 'manual' : existing.signOffMode || 'allowlist',
      watchFields: meta.watchFields?.length ? meta.watchFields : existing.watchFields || [],
      steps: meta.steps?.length ? meta.steps : existing.steps || []
    };
    return seedScenarioFieldRows(merged);
  }
  const signOffMode = meta.signOffMode === 'manual' ? 'manual' : 'allowlist';
  const watchFields = Array.isArray(meta.watchFields) ? meta.watchFields : [];
  return seedScenarioFieldRows({
    tag: meta.tag,
    order: meta.order ?? 0,
    label: meta.label || meta.tag,
    group: meta.group || '',
    checkpoint: meta.checkpoint || '',
    signOffMode,
    watchFields,
    steps: Array.isArray(meta.steps) ? meta.steps : [],
    status: 'not_started',
    markedComplete: false,
    markedCompleteAt: null,
    epochCount: 0,
    logicMismatchCount: 0,
    allowlistFieldCount: signOffMode === 'manual' ? 0 : watchFields.length,
    readyFields: 0,
    blockedFields: 0,
    unobservedFields: signOffMode === 'manual' ? 0 : watchFields.length,
    fields: []
  });
}

function mergeScenarioCatalogIntoReport(catalog, report) {
  if (!catalog?.scenarios?.length) {
    return report || null;
  }
  const scenarios = {};
  const sorted = [...catalog.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const meta of sorted) {
    scenarios[meta.tag] = buildScenarioRecordFromMeta(meta, report?.scenarios?.[meta.tag]);
  }
  const list = Object.values(scenarios);
  const summary =
    report?.summary && report.summary.total === list.length ?
      report.summary
    : {
        total: list.length,
        pass: list.filter((item) => item.status === 'pass').length,
        block: list.filter((item) => item.status === 'block').length,
        inProgress: list.filter((item) => item.status === 'in_progress').length,
        notStarted: list.filter((item) => item.status === 'not_started').length,
        markedComplete: list.filter((item) => item.markedComplete).length
      };
  return {
    boName: catalog.boName || report?.boName || null,
    catalogVersion: catalog.version || report?.catalogVersion || null,
    catalogTitle: catalog.title || report?.catalogTitle || null,
    allowlistVersion: catalog.allowlistVersion || report?.allowlistVersion || null,
    hasNewChainObserved: report?.hasNewChainObserved || false,
    updatedAt: report?.updatedAt || Date.now(),
    summary,
    scenarios
  };
}

function hydrateScenarioReportFromCatalog() {
  if (!ui.scenarioCatalog?.scenarios?.length) {
    return;
  }
  if (!appState) {
    appState = { runtime: null, epochs: [], selectedEpochId: null, issues: [], settings: {} };
  }
  if (isLegacyScenarioReport(appState.scenarioReport) || !appState.scenarioReport) {
    appState.scenarioReport = mergeScenarioCatalogIntoReport(ui.scenarioCatalog, appState.scenarioReport);
  }
}

function getScenarioReportForUi() {
  hydrateScenarioReportFromCatalog();
  return appState?.scenarioReport || null;
}

function isL3ScenarioReady(report) {
  if (!report?.scenarios) {
    return false;
  }
  const tags = Object.keys(report.scenarios);
  const count = tags.length;
  if (!count || !report.catalogVersion) {
    return false;
  }
  if (report.catalogVersion === GOODS_ISSUE_L3_VERSION && count >= 15) {
    return true;
  }
  // 领域 SSOT 上传后：有 boName + version + ≥1 场景即就绪（不再依赖工具仓副本）
  if (report.boName && report.boName !== 'GoodsIssue' && count >= 1) {
    return true;
  }
  return count >= 5 && tags.some((tag) => tag.startsWith('gi-'));
}

async function ensureLocalScenarioCatalog() {
  const boName = await resolveBoNameForAllowlist();
  if (
    ui.scenarioCatalog?.boName &&
    boName &&
    ui.scenarioCatalog.boName === boName &&
    ui.scenarioCatalog?.scenarios?.length
  ) {
    return ui.scenarioCatalog;
  }

  // 仅 GoodsIssue 可从扩展内补；其它 BO 必须上传领域 SSOT
  if (boName !== 'GoodsIssue') {
    return ui.scenarioCatalog || null;
  }

  try {
    const url = chrome.runtime.getURL('scenarios/GoodsIssue.L3.v1.json');
    const response = await fetch(url);
    if (!response.ok) {
      return ui.scenarioCatalog || null;
    }
    const catalog = await response.json();
    ui.scenarioCatalog = catalog;
    hydrateScenarioReportFromCatalog();
    return ui.scenarioCatalog;
  } catch {
    return ui.scenarioCatalog || null;
  }
}

function rememberScenarioCatalog(catalog) {
  if (!catalog?.scenarios?.length) {
    return null;
  }
  ui.scenarioCatalog = catalog;
  if (!appState) {
    appState = { runtime: null, epochs: [], selectedEpochId: null, issues: [], settings: {} };
  }
  appState.scenarioReport = mergeScenarioCatalogIntoReport(catalog, appState.scenarioReport);
  ui.lastSyncedScenarioCatalogKey = `${catalog.boName || ''}:${catalog.version || ''}`;
  const firstTag = [...catalog.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag;
  if (firstTag && (!ui.selectedScenarioTag || !catalog.scenarios.some((s) => s.tag === ui.selectedScenarioTag))) {
    ui.selectedScenarioTag = firstTag;
  }
  lastRefreshFingerprint = '';
  return appState.scenarioReport;
}

function slimEpochForBackground(epoch) {
  if (!epoch || epoch.id == null) {
    return null;
  }
  return {
    id: epoch.id,
    trigger: epoch.trigger,
    phase: epoch.phase,
    startedAt: epoch.startedAt,
    timeLabel: epoch.timeLabel,
    meta: epoch.meta,
    hasNewChain: epoch.hasNewChain,
    allowlistMeta: epoch.allowlistMeta,
    allowlistFieldResults: epoch.allowlistFieldResults,
    diffSummary: epoch.diffSummary,
    scenarioTag: epoch.scenarioTag,
    counts: epoch.counts,
    health: epoch.health,
    anomalies: epoch.anomalies,
    scope: epoch.scope,
    scopeLine: epoch.scopeLine,
    scopeFlow: epoch.scopeFlow,
    groupTitle: epoch.groupTitle,
    detailPathHint: epoch.detailPathHint,
    changedGroups: epoch.changedGroups,
    diffs: epoch.diffs,
    diffGroups: epoch.diffGroups,
    showMain: epoch.showMain,
    showDetail: epoch.showDetail
  };
}

function applyPageSyncToAppState() {
  const page = ui.pageSettings || {};
  const pageEpochs = page.pageSync?.epochs;
  if (!Array.isArray(pageEpochs) || pageEpochs.length === 0) {
    return false;
  }

  if (!appState) {
    appState = {
      runtime: null,
      epochs: [],
      selectedEpochId: null,
      issues: [],
      settings: {}
    };
  }

  const bgEpochCount = appState.epochs?.length || 0;
  const pageLatestId = page.pageSyncSummary?.latestEpochId ?? pageEpochs[0]?.id ?? null;
  const bgLatestId = appState.epochs?.[0]?.id ?? null;
  const pageHasNewerEpoch =
    pageLatestId != null && pageLatestId !== bgLatestId && pageEpochs.some((item) => item.id === pageLatestId);

  if (pageEpochs.length >= bgEpochCount || pageHasNewerEpoch) {
    appState.epochs = pageEpochs;
    dataSource = 'page';
    if (page.pageSync?.runtime) {
      appState.runtime = page.pageSync.runtime;
    } else if (page.pageMeta && !appState.runtime?.meta?.boName) {
      appState.runtime = {
        ...(appState.runtime || {}),
        meta: page.pageMeta,
        diagnostics: appState.runtime?.diagnostics || {}
      };
    }
    maybeSelectLatestEpoch();
    return true;
  }

  dataSource = bgEpochCount > 0 ? 'background' : dataSource;
  return false;
}

function normalizeEpochId(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function epochIdsEqual(a, b) {
  return a == b;
}

function getLatestEpochId() {
  return (
    ui.pageSettings?.pageSyncSummary?.latestEpochId ??
    ui.pageSettings?.pageSync?.epochs?.[0]?.id ??
    appState?.epochs?.[0]?.id ??
    null
  );
}

function maybeSelectLatestEpoch() {
  const latestId = getLatestEpochId();
  if (latestId == null) {
    return;
  }

  const latestChanged = !epochIdsEqual(latestId, lastSyncedLatestEpochId);

  if (!ui.epochFollowLatest && ui.selectedEpochId != null) {
    if (latestChanged) {
      lastSyncedLatestEpochId = latestId;
    }
    return;
  }

  if (latestChanged) {
    ui.selectedEpochId = normalizeEpochId(latestId);
    if (appState) {
      appState.selectedEpochId = ui.selectedEpochId;
    }
  } else if (!ui.selectedEpochId) {
    ui.selectedEpochId = normalizeEpochId(appState?.selectedEpochId || latestId);
  }

  lastSyncedLatestEpochId = latestId;
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getSelectedEpoch() {
  if (!appState?.epochs?.length) {
    return null;
  }
  const id = normalizeEpochId(
    ui.selectedEpochId ?? appState.selectedEpochId ?? appState.epochs[0].id
  );
  return appState.epochs.find((item) => epochIdsEqual(item.id, id)) || appState.epochs[0];
}

async function loadState() {
  if (tabId == null) {
    hydrateScenarioReportFromCatalog();
    return;
  }
  try {
    const response = await safeRuntimeMessage({ type: 'SS_GET_STATE', tabId });
    if (response?.state) {
      appState = response.state;
      appState._bgEpochCount = appState.epochs?.length || 0;
    } else if (!appState) {
      appState = {
        runtime: null,
        epochs: [],
        selectedEpochId: null,
        issues: [],
        settings: {}
      };
    }
  } catch {
    appState = appState || {
      runtime: null,
      epochs: [],
      selectedEpochId: null,
      issues: [],
      settings: {}
    };
  }
  hydrateScenarioReportFromCatalog();
  if (!ui.selectedEpochId && appState.selectedEpochId) {
    ui.selectedEpochId = appState.selectedEpochId;
  }
}

async function syncFromPageIfNeeded() {
  if (tabId == null) {
    return false;
  }

  const page = ui.pageSettings || {};
  const pageEpochCount = getPageEpochCount();
  const bgEpochCount = appState?.epochs?.length || 0;
  const bgHasRuntime = !!appState?.runtime?.meta?.boName;

  const needsSync =
    page.stateScopeInstalled &&
    (page.relayBroken ||
      pageEpochCount > bgEpochCount ||
      (!bgHasRuntime && (page.pageSync?.runtime || page.pageMeta?.boName)));

  if (!needsSync) {
    return false;
  }

  if (!page.pageSync?.epochs?.length && pageEpochCount > 0) {
    await readPageSyncFull();
  }

  const syncPage = ui.pageSettings || {};
  const epochs = syncPage.pageSync?.epochs || [];
  if (!epochs.length) {
    return false;
  }

  try {
    const response = await safeRuntimeMessage({
      type: 'SS_BULK_SYNC',
      tabId,
      runtime: syncPage.pageSync?.runtime || syncPage.pageSyncSummary?.runtime || null,
      epochs: epochs.map(slimEpochForBackground).filter(Boolean)
    });
    if (response?.ok) {
      ui.panelSyncMessage =
        bgEpochCount === 0 && pageEpochCount > 0
          ? `Background 已同步 ${response.epochCount || pageEpochCount} 条摘要（展示用完整数据来自页面）`
          : '';
      return true;
    }
    ui.panelSyncMessage = response?.error || 'Background 同步失败';
  } catch (error) {
    ui.panelSyncMessage = `Background 同步失败：${error.message}`;
  }

  return false;
}

async function resyncPanelFromPage() {
  await readPageSettings();
  const page = ui.pageSettings || {};
  if (!page.stateScopeInstalled) {
    showToast('injector 未挂载，请先刷新单据页');
    return;
  }

  await evalInPage('window.__StateScope__?.syncPanelState?.()');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await readPageSyncFull();
  await loadState();
  await syncFromPageIfNeeded();
  await loadState();
  applyPageSyncToAppState();

  renderApp();
  bindAppEvents();
  showToast(ui.panelSyncMessage || '同步完成');
}

function evalInPage(expression) {
  return new Promise((resolve) => {
    if (!chrome.devtools?.inspectedWindow?.eval) {
      resolve({ ok: false, error: '无法访问 inspectedWindow' });
      return;
    }
    try {
      chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
        if (exceptionInfo) {
          resolve({
            ok: false,
            error: exceptionInfo.value || exceptionInfo.description || 'eval failed'
          });
          return;
        }
        resolve({ ok: true, result });
      });
    } catch (error) {
      resolve({ ok: false, error: error?.message || 'eval unavailable' });
    }
  });
}

async function readPageSettings(options = {}) {
  const includeAllowlistFields = options.includeAllowlistFields === true;
  const allowlistFieldsExpr = includeAllowlistFields ?
      `(window.__StateScope__?.getAllowlistConfig?.()?.fields || []).map(function (f) {
        return { path: f.path, stateType: f.stateType, configKey: f.configKey, oldEntry: f.oldEntry };
      })`
    : '[]';

  const response = await evalInPage(`({
    bizDebug: localStorage.getItem('bizDebug') === 'true',
    stateScopeVerbose: localStorage.getItem('stateScopeVerbose') === 'true',
    stateScopeDebug: localStorage.getItem('stateScopeDebug') === 'true',
    stateScopeAutoAllowlist: localStorage.getItem('stateScopeAutoAllowlist') !== 'false',
    stateScopeProfile: window.__StateScope__?.getProfileMode?.() || localStorage.getItem('stateScopeProfile') || 'auto',
    profileDetection: window.__StateScope__?.getProfileDetection?.() || null,
    stateScopeInstalled: !!(window.__StateScope__ && window.__StateScope__.installed),
    allowlistActive: !!(window.__StateScope__?.getAllowlistConfig?.()),
    allowlistFieldCount: window.__StateScope__?.getAllowlistConfig?.()?.fields?.length || 0,
    allowlistVersion: window.__StateScope__?.getAllowlistConfig?.()?.version || '',
    allowlistBoName: window.__StateScope__?.getAllowlistConfig?.()?.boName || '',
    allowlistNote: window.__StateScope__?.getAllowlistConfig?.()?.note || '',
    allowlistFields: ${allowlistFieldsExpr},
    loadedAllowlistKeys: window.__StateScope__?.listLoadedAllowlists?.() || [],
    pageMeta: window.__StateScope__?.getMeta?.() || null,
    pageSyncSummary: window.__StateScope__?.getPanelSyncSummary?.() || null,
    relayBroken: window.__StateScope__?.extensionRelayBroken === true,
    relayError: window.__StateScope__?.extensionRelayError || ''
  })`);
  if (response.ok) {
    ui.pageSettings = response.result;
    ui.pageSettings.pageSyncEpochCount = ui.pageSettings.pageSyncSummary?.epochCount || 0;
  }
  return response;
}

async function readPageSyncFull() {
  const response = await evalInPage(`window.__StateScope__?.getPanelSyncPayload?.() || null`);
  if (response.ok && response.result) {
    ui.pageSettings = {
      ...(ui.pageSettings || {}),
      pageSync: response.result,
      pageSyncEpochCount: response.result.epochs?.length || 0,
      pageSyncSummary: {
        ...(ui.pageSettings?.pageSyncSummary || {}),
        epochCount: response.result.epochs?.length || 0,
        latestEpochId: response.result.epochs?.[0]?.id ?? null,
        latestStartedAt: response.result.epochs?.[0]?.startedAt ?? null
      }
    };
    lastPageSyncEpochCount = ui.pageSettings.pageSyncEpochCount;
    lastSyncedLatestEpochId = ui.pageSettings.pageSyncSummary?.latestEpochId ?? null;
    applyPageSyncToAppState();
    return response.result;
  }
  return null;
}

function getPageEpochCount() {
  return ui.pageSettings?.pageSync?.epochs?.length ?? ui.pageSettings?.pageSyncEpochCount ?? 0;
}

function getActivationState() {
  const runtimeDiag = appState?.runtime?.diagnostics || {};
  const page = ui.pageSettings || {};
  const bizDebug = page.bizDebug === true || runtimeDiag.bizDebug === true;
  const hooksOk = !!(
    runtimeDiag.formController ||
    runtimeDiag.uiStateController ||
    runtimeDiag.presenter ||
    runtimeDiag.stateManager ||
    runtimeDiag.lowcodeViewModel ||
    page.stateScopeInstalled
  );
  const hasEpochs = (appState?.epochs?.length || 0) > 0;

  if (!bizDebug) {
    return {
      level: 'off',
      label: '未激活',
      bizDebug: false,
      hint: 'localStorage.bizDebug 不是 true，或设置后尚未刷新页面'
    };
  }

  if (!hooksOk && !hasEpochs) {
    return {
      level: 'wait',
      label: '等待挂载',
      bizDebug: true,
      hint: 'bizDebug 已开启，但 injector 尚未挂上单据。请刷新页面，或等单据渲染完成后点设置里的刷新'
    };
  }

  return {
    level: 'on',
    label: '已激活',
    bizDebug: true,
    hint: page.relayBroken ? 'Console 有输出但 Panel 无数据：extension 通道断开，请 F5 刷新单据页或点「重新同步」' : ''
  };
}

async function enableAllDebugSettings() {
  const response = await evalInPage(`(function () {
    try {
      localStorage.setItem('bizDebug', 'true');
      localStorage.setItem('stateScopeVerbose', 'true');
      localStorage.setItem('stateScopeDebug', 'true');
      window.bizDebug = true;
      return {
        ok: true,
        bizDebug: localStorage.getItem('bizDebug') === 'true',
        stateScopeVerbose: localStorage.getItem('stateScopeVerbose') === 'true',
        stateScopeDebug: localStorage.getItem('stateScopeDebug') === 'true'
      };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  })()`);

  if (response.ok && response.result?.ok !== false) {
    await readPageSettings();
    ui.settingsMessage =
      '已写入 bizDebug。injector 仅在页面加载时挂载，请点击「刷新单据页」或下方「一键开启并刷新」。';
    showToast('已开启 bizDebug，请刷新单据页');
    lastRefreshFingerprint = '';
    return true;
  }

  ui.settingsMessage = `写入失败：${response.result?.error || response.error || '无法在单据页执行 eval'}`;
  showToast(ui.settingsMessage);
  return false;
}

async function enableAndReloadPage() {
  const ok = await enableAllDebugSettings();
  if (ok) {
    await reloadInspectedPage();
  }
}

async function reloadInspectedPage() {
  await evalInPage('location.reload()');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch {
    showToast('复制失败');
  }
}

function showToast(message) {
  const el = document.getElementById('toast');
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 1600);
  }
}

function getCutoverReport() {
  return appState?.cutoverReport || null;
}

function getAllowlistMetaLine() {
  const report = getCutoverReport();
  const ps = ui.pageSettings || {};
  const binding = ui.allowlistBinding || {};
  const boName =
    report?.boName || binding.boName || ps.allowlistBoName || ps.pageMeta?.boName || ui.lastSyncedBoName;
  const version = report?.allowlistVersion || binding.version || ps.allowlistVersion;
  const fieldCount = report?.summary?.totalFields || binding.fieldCount || ps.allowlistFieldCount;
  const active = ps.allowlistActive || binding.active;

  if (boName || active) {
    const fieldPart = fieldCount ? `${fieldCount} 字段 · ` : '';
    return `${boName || '—'} · allowlist v${version || '—'} · ${fieldPart}new轨 ${report?.hasNewChainObserved ? '已观测' : '未接入'}`;
  }
  return 'allowlist 未绑定';
}

function applyScenarioMarkLocally(tag, record, summary) {
  if (!tag || !record) {
    return;
  }
  if (!appState) {
    appState = { runtime: null, epochs: [], selectedEpochId: null, issues: [], settings: {} };
  }
  if (!appState.scenarioReport) {
    appState.scenarioReport = { scenarios: {}, summary: {}, updatedAt: Date.now() };
  }
  appState.scenarioReport.scenarios[tag] = record;
  if (summary) {
    appState.scenarioReport.summary = summary;
  } else if (appState.scenarioReport.scenarios) {
    const list = Object.values(appState.scenarioReport.scenarios);
    appState.scenarioReport.summary = {
      total: list.length,
      pass: list.filter((item) => item.status === 'pass').length,
      block: list.filter((item) => item.status === 'block').length,
      inProgress: list.filter((item) => item.status === 'in_progress').length,
      notStarted: list.filter((item) => item.status === 'not_started').length,
      markedComplete: list.filter((item) => item.markedComplete).length
    };
  }
  appState.scenarioReport.updatedAt = Date.now();
  lastRefreshFingerprint = '';
}

function getCutoverVerdict(report) {
  if (!report?.fields?.length) {
    return {
      status: 'idle',
      headline: '尚无 allowlist 累计数据',
      subline: '加载 allowlist 并操作单据字段后自动累计'
    };
  }
  if (!report.hasNewChainObserved) {
    return {
      status: 'warn',
      headline: 'new 轨未接入',
      subline: '切流验收需升级模式 + statePatches'
    };
  }
  const blocked = report.summary?.blockedFields || 0;
  const ready = report.summary?.readyFields || 0;
  const total = report.summary?.totalFields || 0;
  if (blocked > 0) {
    return {
      status: 'error',
      headline: `BLOCK · ${blocked} 个字段存在 logic-mismatch`,
      subline: `就绪 ${ready}/${total} · 累计 ${total} 个 allowlist 字段`
    };
  }
  if (ready === total && total > 0) {
    return {
      status: 'ok',
      headline: `PASS · ${ready}/${total} 字段可切流`,
      subline: '当前会话 allowlist 字段均无 logic-mismatch'
    };
  }
  return {
    status: 'warn',
    headline: `进行中 · 就绪 ${ready}/${total}`,
    subline: `${report.summary?.unobservedFields || 0} 个字段尚未观测`
  };
}

async function resolveBoNameForAllowlist() {
  const fromRuntime = appState?.runtime?.meta?.boName;
  if (fromRuntime && fromRuntime !== '(unknown)') {
    return fromRuntime;
  }
  const fromPage = ui.pageSettings?.pageMeta?.boName;
  if (fromPage) {
    return fromPage;
  }
  const metaResult = await evalInPage(`window.__StateScope__?.getMeta?.()?.boName || ''`);
  return metaResult.ok ? metaResult.result || '' : '';
}

async function syncAllowlistToPage({ force = false } = {}) {
  const ps = ui.pageSettings;
  if (!force && ps && ps.stateScopeAutoAllowlist === false) {
    return { ok: false, reason: 'auto-disabled' };
  }

  // 页面 injector 已绑定（bundled / bridge），无需 Panel 再 fetch
  if (!force && ps?.allowlistActive) {
    ui.lastSyncedBoName = ps.allowlistBoName || ps.pageMeta?.boName || ui.lastSyncedBoName;
    ui.allowlistBinding = {
      boName: ps.allowlistBoName || ui.lastSyncedBoName,
      version: ps.allowlistVersion,
      fieldCount: ps.allowlistFieldCount,
      active: true
    };
    if (ui.settingsMessage && /未找到|加载失败|injector 未就绪/.test(ui.settingsMessage)) {
      ui.settingsMessage = '';
    }
    return { ok: true, reason: 'page-active' };
  }

  const boName = await resolveBoNameForAllowlist();
  if (!force && boName && boName === ui.lastSyncedBoName && ps?.allowlistActive) {
    return { ok: true, reason: 'already-synced' };
  }

  const candidates = boName ?
      [`${boName}.v1.json`, `${boName}.v1.example.json`, 'OutsourceIssue.v1.json', 'GoodsIssue.v1.json']
    : ['OutsourceIssue.v1.json', 'GoodsIssue.v1.json', 'GoodsIssue.v1.example.json'];

  for (const fileName of candidates) {
    try {
      const url = chrome.runtime.getURL(`allowlists/${fileName}`);
      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }
      const config = await response.json();
      if (boName && config.boName && config.boName !== boName) {
        continue;
      }
      const payload = JSON.stringify(config);
      const evalResult = await evalInPage(
        `(function (config) {
          if (!window.__StateScope__?.applyAllowlistConfig) {
            return { ok: false, error: 'injector 未就绪' };
          }
          const applied = window.__StateScope__.applyAllowlistConfig(config);
          const active = !!window.__StateScope__.getAllowlistConfig?.();
          return {
            ok: applied,
            active,
            version: config.version,
            fieldCount: config.fields?.length || 0,
            boName: config.boName
          };
        })(${payload})`
      );
      if (evalResult.ok && evalResult.result?.ok) {
        ui.lastSyncedBoName = config.boName || boName || ui.lastSyncedBoName;
        ui.allowlistBinding = {
          boName: evalResult.result.boName || config.boName,
          version: evalResult.result.version || config.version,
          fieldCount: evalResult.result.fieldCount || config.fields?.length || 0,
          active: evalResult.result.active
        };
        ui.pageSettings = {
          ...(ui.pageSettings || {}),
          allowlistActive: !!evalResult.result.active,
          allowlistBoName: ui.allowlistBinding.boName,
          allowlistVersion: ui.allowlistBinding.version,
          allowlistFieldCount: ui.allowlistBinding.fieldCount
        };
        lastRefreshFingerprint = '';
        ui.settingsMessage = evalResult.result.active ?
            `allowlist 已绑定：${evalResult.result.boName} v${evalResult.result.version}（${evalResult.result.fieldCount} 字段）`
          : `allowlist 已写入但未激活，boName=${evalResult.result.boName || '?'}`;
        return { ok: true, ...evalResult.result };
      }
      if (force && evalResult.result?.error) {
        ui.settingsMessage = evalResult.result.error;
      }
    } catch {
      // try next candidate
    }
  }

  if (force) {
    ui.settingsMessage = boName ?
        `未找到 ${boName} 的 allowlist 文件（allowlists/*.json）`
      : '未识别 boName，且默认 GoodsIssue allowlist 加载失败';
  }
  return { ok: false, reason: 'not-found' };
}

async function applyScenarioCatalogToPage(catalog) {
  const payload = JSON.stringify(catalog);
  return evalInPage(
    `(function (config) {
      if (!window.__StateScope__?.applyScenarioCatalog) {
        return { ok: false, error: 'injector 未就绪或未升级' };
      }
      const applied = window.__StateScope__.applyScenarioCatalog(config);
      const summary = window.__StateScope__.getScenarioCatalogSummary?.() || null;
      return { ok: applied, summary };
    })(${payload})`
  );
}

async function applyScenarioCatalogBundle(catalog) {
  if (tabId == null) {
    return { ok: false, reason: 'no-tab' };
  }
  const swResponse = await chrome.runtime.sendMessage({
    type: 'SS_APPLY_SCENARIO_CATALOG',
    tabId,
    catalog
  });
  if (!swResponse?.ok) {
    return swResponse || { ok: false, error: '后台应用失败' };
  }
  // 使用 SW 归一化后的 pack（领域 SSOT → tag/steps/watchFields）
  const normalized = swResponse.catalog || catalog;
  rememberScenarioCatalog(normalized);
  ui.lastSyncedScenarioCatalogKey = `${swResponse.boName}:${swResponse.version}`;
  if (swResponse.scenarioReport) {
    appState.scenarioReport = swResponse.scenarioReport;
    hydrateScenarioReportFromCatalog();
  }
  await applyScenarioCatalogToPage(normalized);
  await loadState();
  return swResponse;
}

async function syncScenarioCatalogToBackground({ force = false, catalog = null } = {}) {
  if (tabId == null) {
    return { ok: false, reason: 'no-tab' };
  }

  if (catalog) {
    return applyScenarioCatalogBundle(catalog);
  }

  const boName = await resolveBoNameForAllowlist();
  const report = appState?.scenarioReport;
  const expectedKey = `${boName || report?.boName || ''}:${report?.catalogVersion || ''}`;

  if (
    !force &&
    boName &&
    report?.boName === boName &&
    isL3ScenarioReady(report)
  ) {
    ui.lastSyncedScenarioCatalogKey = expectedKey;
    return { ok: true, reason: 'already-synced', boName: report.boName, version: report.catalogVersion };
  }

  if (!boName) {
    return { ok: false, reason: 'no-boName', error: '未识别 boName，无法加载场景 checklist' };
  }

  try {
    const bootstrap = await chrome.runtime.sendMessage({
      type: 'SS_BOOTSTRAP_SCENARIO_CATALOG',
      tabId,
      boName,
      force: force || report?.boName !== boName
    });
    if (bootstrap?.ok) {
      if (bootstrap.catalog) {
        rememberScenarioCatalog(bootstrap.catalog);
        await applyScenarioCatalogToPage(bootstrap.catalog);
      }
      if (bootstrap.scenarioReport) {
        appState = appState || {};
        appState.scenarioReport = bootstrap.scenarioReport;
        hydrateScenarioReportFromCatalog();
      }
      ui.lastSyncedScenarioCatalogKey = `${bootstrap.boName}:${bootstrap.version}`;
      await loadState();
      return bootstrap;
    }
    if (bootstrap?.needsUpload) {
      return {
        ok: false,
        reason: 'needs-upload',
        needsUpload: true,
        boName,
        error: bootstrap.error || `${boName} 请上传领域 *.scenarios.v1.json`
      };
    }
  } catch {
    // fall through
  }

  // 仅 GoodsIssue 可从扩展内 scenarios/*.json 补；其它 BO 强制上传 SSOT
  if (boName === 'GoodsIssue') {
    try {
      const url = chrome.runtime.getURL('scenarios/GoodsIssue.L3.v1.json');
      const response = await fetch(url);
      if (response.ok) {
        return applyScenarioCatalogBundle(await response.json());
      }
    } catch {
      // ignore
    }
  }

  return {
    ok: false,
    reason: 'needs-upload',
    needsUpload: true,
    boName,
    error: `${boName} 无内置场景包，请在「场景回归」上传领域 SSOT（*.scenarios.v1.json）`
  };
}

function cutoverRowsToCsv(report) {
  const header = [
    'path',
    'stateType',
    'configKey',
    'oldEntry',
    'epochCount',
    'logicMismatchCount',
    'lastSeverity',
    'cutoverReady',
    'blockReason'
  ];
  const rows = (report?.fields || []).map((item) =>
    [
      item.path,
      item.stateType,
      item.configKey,
      item.oldEntry,
      item.epochCount,
      item.logicMismatchCount,
      item.lastSeverity,
      item.cutoverReady ? 'true' : 'false',
      item.blockReason || ''
    ]
      .map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`)
      .join(',')
  );
  return [header.join(','), ...rows].join('\n');
}

async function exportCutoverJson() {
  const report = getCutoverReport();
  if (!report) {
    showToast('尚无切流报告');
    return;
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    tabId,
    runtime: getRuntimeContext(),
    cutoverReport: report
  };
  await copyText(JSON.stringify(payload, null, 2));
}

async function exportCutoverCsv() {
  const report = getCutoverReport();
  if (!report?.fields?.length) {
    showToast('尚无切流报告');
    return;
  }
  await copyText(cutoverRowsToCsv(report));
}

async function resetCutoverReport() {
  if (tabId == null) {
    return;
  }
  await chrome.runtime.sendMessage({ type: 'SS_RESET_CUTOVER', tabId });
  await refresh();
  showToast('已重置切流累计');
}

async function clearAllowlistOnPage() {
  const boName = appState?.runtime?.meta?.boName || '';
  const expr = boName ?
      `(function () {
        if (!window.__StateScope__?.clearAllowlist) return { ok: false, error: 'API 不可用' };
        return { ok: window.__StateScope__.clearAllowlist(${JSON.stringify(boName)}) };
      })()`
    : `(function () {
        if (!window.__StateScope__?.clearAllowlist) return { ok: false, error: 'API 不可用' };
        return { ok: window.__StateScope__.clearAllowlist() };
      })()`;
  const response = await evalInPage(expr);
  if (response.ok && response.result?.ok) {
    ui.lastSyncedBoName = boName || '__cleared__';
    if (tabId != null) {
      await chrome.runtime.sendMessage({ type: 'SS_RESET_CUTOVER', tabId });
    }
    await readPageSettings();
    ui.settingsMessage = '已取消 allowlist，Diff 恢复全量对比。';
    showToast('allowlist 已清除');
  } else {
    ui.settingsMessage = `清除 allowlist 失败：${response.result?.error || response.error || '未知错误'}`;
  }
}

async function setAutoAllowlistOnPage(enabled) {
  const response = await evalInPage(`(function () {
    if (!window.__StateScope__?.setAutoAllowlistEnabled) {
      localStorage.setItem('stateScopeAutoAllowlist', ${enabled ? "'true'" : "'false'"});
      if (!${enabled ? 'true' : 'false'} && window.__StateScope__?.clearAllowlist) {
        window.__StateScope__.clearAllowlist();
      }
      return { ok: true, stateScopeAutoAllowlist: ${enabled ? 'true' : 'false'} };
    }
    window.__StateScope__.setAutoAllowlistEnabled(${enabled ? 'true' : 'false'});
    return {
      ok: true,
      stateScopeAutoAllowlist: localStorage.getItem('stateScopeAutoAllowlist') !== 'false',
      allowlistActive: !!window.__StateScope__.getAllowlistConfig?.()
    };
  })()`);
  if (response.ok) {
    ui.lastSyncedBoName = null;
    ui.pageSettings = { ...(ui.pageSettings || {}), ...response.result };
    ui.settingsMessage = enabled ?
        '已开启自动加载 allowlist。刷新页面或点击「重新加载 allowlist」生效。'
      : '已关闭自动加载并清除当前 allowlist。';
    if (tabId != null && !enabled) {
      await chrome.runtime.sendMessage({ type: 'SS_RESET_CUTOVER', tabId });
    }
  } else {
    ui.settingsMessage = `设置失败：${response.error || '未知错误'}`;
  }
}

function renderCutoverTable(report) {
  const fields = report?.fields || [];
  if (!fields.length) {
    return '<div class="empty">尚无 allowlist 字段累计。请确认 allowlists/*.json 已加载，并操作单据触发 Epoch。</div>';
  }

  return `<div class="cutover-table-wrap">
    <table class="cutover-table">
      <thead>
        <tr>
          <th>字段</th>
          <th>累计 Epoch</th>
          <th>Mismatch</th>
          <th>最近结果</th>
          <th>切流</th>
        </tr>
      </thead>
      <tbody>
        ${fields
          .map(
            (item) => `<tr class="${item.logicMismatchCount > 0 ? 'row-bad' : item.cutoverReady ? 'row-ok' : ''}">
              <td>
                <div class="field-name">${esc(item.path)}</div>
                <div class="field-path">${esc(item.stateType)} · ${esc(item.configKey || '—')}</div>
              </td>
              <td>${item.epochCount}</td>
              <td>${item.logicMismatchCount}</td>
              <td><span class="chip">${esc(item.lastSeverity)}</span></td>
              <td>${item.cutoverReady ? '<span class="chip on">READY</span>' : `<span class="chip off">${esc(item.blockReason || 'BLOCK')}</span>`}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

function renderCutoverTab() {
  const report = getCutoverReport();
  const verdict = getCutoverVerdict(report);
  const summary = report?.summary || {};
  const metaLine = getAllowlistMetaLine();

  return `<div class="cutover-page">
    ${renderVerdict(verdict)}
    <div class="card">
      <div class="card-head">切流报告 · ${esc(metaLine)}</div>
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">字段总数</div><div class="kpi-value">${summary.totalFields || 0}</div></div>
        <div class="kpi"><div class="kpi-label">READY</div><div class="kpi-value">${summary.readyFields || 0}</div></div>
        <div class="kpi"><div class="kpi-label">BLOCK</div><div class="kpi-value">${summary.blockedFields || 0}</div></div>
      </div>
      <div class="toolbar">
        <button type="button" class="btn" id="export-cutover-json">导出 JSON</button>
        <button type="button" class="btn" id="export-cutover-csv">导出 CSV</button>
        <button type="button" class="btn" id="reset-cutover">重置累计</button>
        <button type="button" class="btn" id="resync-allowlist">重新加载 allowlist</button>
      </div>
      ${renderCutoverTable(report)}
    </div>
    <div class="banner info">切流报告按 allowlist 字段跨 Epoch 累计 logic-mismatch；开发向 Epoch/Diff 监测保持不变。</div>
  </div>`;
}

function updateCutoverNavBadge() {
  const badge = document.getElementById('cutover-nav-badge');
  if (!badge) {
    return;
  }
  const blocked = getCutoverReport()?.summary?.blockedFields || 0;
  if (blocked > 0) {
    badge.textContent = String(blocked);
    badge.className = 'nav-badge nav-badge-bad';
  } else {
    badge.textContent = '';
    badge.className = 'nav-badge';
  }
}

function getPanelCtx() {
  return {
    ui,
    appState,
    tabId,
    esc,
    showToast,
    copyText,
    evalInPage,
    getSelectedEpoch,
    renderVerdict,
    renderApp,
    bindAppEvents,
    refresh,
    syncScenarioCatalog: syncScenarioCatalogToBackground,
    getScenarioReport: getScenarioReportForUi,
    isL3ScenarioReady,
    applyScenarioMarkLocally
  };
}

function getIssuesCtx() {
  return getPanelCtx();
}

function getRuntimeContext() {
  const runtime = appState?.runtime;
  const epoch = getSelectedEpoch();
  const page = ui.pageSettings || {};
  const pageSyncRuntime = page.pageSync?.runtime;
  return {
    diag: runtime?.diagnostics || pageSyncRuntime?.diagnostics || {},
    meta: runtime?.meta || pageSyncRuntime?.meta || epoch?.meta || page.pageMeta || {}
  };
}

function renderChrome() {
  const { diag, meta } = getRuntimeContext();
  const epoch = getSelectedEpoch();
  const activation = getActivationState();
  const badge = document.getElementById('activation-badge');
  if (badge) {
    badge.textContent = activation.label;
    badge.className = `status-badge ${activation.level === 'on' ? 'on' : activation.level === 'wait' ? 'wait' : 'off'}`;
    badge.title = activation.hint || '';
  }

  const headerMeta = document.getElementById('header-meta');
  if (headerMeta) {
    const profile = meta.profile || epoch?.meta?.profile || '—';
    const oldOk =
      profile === 'lowcode' ?
        diag.lowcodeViewModel
      : diag.formController || diag.uiStateController;
    const det = meta.profileDetection || diag.profileDetection;
    const profileTitle = det?.reason ? esc(det.reason) : '';
    const conf = det?.confidence ? ` · ${esc(det.confidence)}` : '';
    const newOk =
      profile === 'lowcode' ?
        diag.mdfBizApplication || diag.mdfDoDispatch || diag.lowcodeViewModel
      : diag.stateManager;
    headerMeta.innerHTML = `
      <span>单据 <strong>${esc(meta.boName || '(unknown)')}</strong></span>
      <span class="sep">|</span>
      <span>Profile <strong title="${profileTitle}">${esc(profile)}</strong>${conf}</span>
      <span class="sep">|</span>
      <span>old <span class="${oldOk ? 'chain-ok' : 'chain-off'}">${oldOk ? '✓' : '✗'}</span></span>
      <span>${profile === 'lowcode' ? 'shadow' : 'new'} <span class="${newOk ? 'chain-ok' : 'chain-off'}">${newOk ? '✓' : '✗'}</span></span>
    `;
  }

  const footer = document.getElementById('sidebar-footer');
  if (footer) {
    const count = appState?.epochs?.length || 0;
    const pageEpochCount = getPageEpochCount();
    const updated = epoch?.timeLabel || '—';
    const relayWarn = ui.pageSettings?.relayBroken
      ? `<div class="footer-line footer-warn">通道断开：${esc(ui.pageSettings.relayError || '请 F5 刷新单据页')}</div>`
      : '';
    const syncNote = ui.panelSyncMessage
      ? `<div class="footer-line footer-warn">${esc(ui.panelSyncMessage)}</div>`
      : '';
    const sourceLine =
      dataSource === 'page' && count > 0
        ? `<div class="footer-line">展示数据源：页面缓存 (${count} 条)</div>`
        : `<div class="footer-line">展示数据源：extension (${count} 条)</div>`;
    footer.innerHTML = `
      <div class="footer-line">tabId ${tabId ?? '—'}</div>
      ${sourceLine}
      <div class="footer-line">最近事件 ${esc(updated)}</div>
      <div class="footer-line">页面缓存 ${pageEpochCount} 条 · Background ${appState?._bgEpochCount ?? '—'} 条</div>
      ${relayWarn}
      ${syncNote}
      <button type="button" class="btn-link" id="resync-panel-data">重新同步 Panel</button>
      <button type="button" class="btn-link" id="copy-diagnostic-info">复制 Diagnostic Info</button>
    `;
  }
}

function getEpochHealth(epoch) {
  if (epoch?.health) {
    return epoch.health;
  }
  if (!epoch) {
    return { status: 'idle', headline: '等待 Epoch', subline: '操作单据字段后自动更新' };
  }
  const mismatch = epoch.diffSummary?.logicMismatch || 0;
  const changed = epoch.counts?.changedSample || 0;
  if (mismatch > 0) {
    return { status: 'error', headline: `发现 ${mismatch} 个逻辑差异`, subline: 'old 与 new 状态不一致' };
  }
  if (epoch.hasNewChain) {
    return { status: 'ok', headline: '本次双轨一致', subline: `${changed} 个变更字段` };
  }
  if (changed > 0) {
    return { status: 'warn', headline: `已捕获 ${changed} 个变更字段`, subline: 'new 轨未接入' };
  }
  return { status: 'idle', headline: '本次无字段变更', subline: 'Epoch 已记录' };
}

function getEpochImpact(epoch) {
  if (epoch?.impact) {
    return epoch.impact;
  }
  return {
    main: epoch?.sections?.main?.count || 0,
    detail: epoch?.sections?.detail?.count || 0,
    changed: epoch?.counts?.changedSample || 0,
    final: epoch?.counts?.finalSnap || 0,
    mismatch: epoch?.diffSummary?.logicMismatch || 0,
    ok: epoch?.diffSummary?.ok || 0
  };
}

function groupChangedFallback(epoch) {
  const rows = epoch?.sections?.changedSet?.rows || [];
  const main = [];
  const detailMap = new Map();
  for (const row of rows) {
    const parsed = row.parsed;
    if (!parsed || parsed.area === 'main') {
      main.push({
        field: parsed?.field || row.path.split('.')[1] || row.path,
        label: row.label,
        path: row.path,
        changed: row.changed
      });
      continue;
    }
    const key = `${parsed.body}.${parsed.rowKey}`;
    if (!detailMap.has(key)) {
      detailMap.set(key, { body: parsed.body, rowKey: parsed.rowKey, rowLabel: parsed.rowKey, fields: [] });
    }
    detailMap.get(key).fields.push({
      field: parsed.field,
      label: row.label,
      path: row.path,
      changed: row.changed
    });
  }
  return { main, details: [...detailMap.values()] };
}

function renderVerdict(health) {
  if (!health) {
    return '';
  }
  const icon =
    health.status === 'error' ? '❌'
    : health.status === 'warn' ? '⚠️'
    : health.status === 'ok' ? '✅'
    : '○';
  return `<div class="verdict verdict-${esc(health.status)}">
    <div class="verdict-icon">${icon}</div>
    <div class="verdict-body">
      <div class="verdict-title">${esc(health.headline)}</div>
      <div class="verdict-sub">${esc(health.subline)}</div>
    </div>
  </div>`;
}

function renderStatGrid(impact) {
  if (!impact) {
    return '';
  }
  return `<div class="stat-grid">
    <div class="stat"><div class="stat-label">表头终态</div><div class="stat-value">${impact.main}</div></div>
    <div class="stat"><div class="stat-label">明细终态</div><div class="stat-value">${impact.detail}</div></div>
    <div class="stat"><div class="stat-label">变更集</div><div class="stat-value">${impact.changed}</div></div>
    <div class="stat stat-accent"><div class="stat-label">Mismatch</div><div class="stat-value">${impact.mismatch}</div></div>
  </div>`;
}

function renderScopeFlow(steps) {
  if (!steps?.length) {
    return '<div class="empty">暂无 scope 流程信息</div>';
  }
  return `<div class="flow">${steps
    .map(
      (step) => `<div class="flow-step">
        <div class="flow-icon">${esc(step.icon)}</div>
        <div><div class="flow-title">${esc(step.title)}</div><div class="flow-detail">${esc(step.detail)}</div></div>
      </div>`
    )
    .join('')}</div>`;
}

function renderFieldActions(path) {
  return `<div class="row-actions">
    <button type="button" class="btn-mini" data-copy-path="${esc(path)}" title="Copy Path">Path</button>
    <button type="button" class="btn-mini" data-copy-json="${esc(path)}" title="Copy JSON">JSON</button>
  </div>`;
}

function renderChangedGroups(epoch) {
  const groups = epoch.changedGroups || { main: [], details: [] };
  const mainHtml =
    groups.main.length ?
      `<div class="group-card">
        <div class="group-title">表头 · ${groups.main.length} 项</div>
        ${groups.main
          .map(
            (item) => `<div class="field-row ${item.changed ? 'changed' : ''}">
              <div class="field-main">
                <div class="field-name">${esc(item.field)}</div>
                ${ui.showPaths ? `<div class="field-path">${esc(item.path)}</div>` : ''}
              </div>
              <span class="chip ${item.label === '可编辑' ? 'on' : 'off'}">${esc(item.label)}</span>
              ${renderFieldActions(item.path)}
            </div>`
          )
          .join('')}
      </div>`
    : '';

  const detailHtml = (groups.details || [])
    .map(
      (group) => `<div class="group-card">
        <div class="group-title">${esc(group.body)} · ${esc(group.rowLabel)} · ${group.fields.length} 项</div>
        ${group.fields
          .map(
            (item) => `<div class="field-row ${item.changed ? 'changed' : ''}">
              <div class="field-main">
                <div class="field-name">${esc(item.field)}</div>
                ${ui.showPaths ? `<div class="field-path">${esc(item.path)}</div>` : ''}
              </div>
              <span class="chip ${item.label === '可编辑' ? 'on' : 'off'}">${esc(item.label)}</span>
              ${renderFieldActions(item.path)}
            </div>`
          )
          .join('')}
      </div>`
    )
    .join('');

  if (!mainHtml && !detailHtml) {
    return '<div class="empty">变更集为空</div>';
  }

  return `${mainHtml}${detailHtml}`;
}

function renderAnomalies(anomalies) {
  if (!anomalies?.length) {
    return `<div class="hero-panel hero-panel-ok">
      <div class="hero-panel-title">✅ 暂无需要关注的问题</div>
      <div class="subtle">当前 Epoch 无 logic-mismatch；pending 项可在 Diff Tab 查看 old 预览。</div>
    </div>`;
  }

  return `<div class="hero-panel hero-panel-alert">
    <div class="hero-panel-title">🔥 需要关注 · ${anomalies.length} 项</div>
    ${anomalies
      .map(
        (item) => `<div class="anomaly-row-wrap">
          <button type="button" class="anomaly-row" data-goto-tab="diff" data-focus-path="${esc(item.path)}">
            <div class="anomaly-field">${esc(item.field)}${item.gridHint ? ` <span class="subtle">(${esc(item.gridHint)})</span>` : ''}</div>
            <div class="anomaly-msg">${esc(item.message)}</div>
            <div class="anomaly-action">查看 Diff →</div>
          </button>
          ${window.StateScopeIssuesUI?.enhanceAnomalyRow(getIssuesCtx(), item) || ''}
        </div>`
      )
      .join('')}
  </div>`;
}

function renderOverviewHero(epoch) {
  if (!epoch) {
    return `<div class="overview-hero">${renderVerdict(getEpochHealth(null))}</div>`;
  }
  return `<div class="overview-hero">
    ${renderVerdict(getEpochHealth(epoch))}
    ${renderAnomalies(epoch.anomalies || [])}
  </div>`;
}

function renderDetailGridsBody(epoch) {
  const detail = epoch.sections?.detail;
  const detailGrids = ui.detailAllColumns ? detail?.gridsAll || detail?.grids || [] : detail?.grids || [];

  if (!detailGrids.length) {
    return '<div class="empty">无明细终态</div>';
  }

  return detailGrids
    .map(
      (grid) => `<div class="group-card">
        <div class="group-title">${esc(grid.body)} · ${esc(grid.rowLabel)} · ${grid.columns.length} 列</div>
        ${grid.columns
          .map(
            (col) => `<div class="field-row ${col.changed ? 'changed' : ''}">
            <div class="field-main">
              <div class="field-name">${esc(col.field)}</div>
              ${ui.showPaths ? `<div class="field-path">${esc(col.path)}</div>` : ''}
            </div>
            <span class="chip ${col.label === '可编辑' ? 'on' : 'off'}">${esc(col.label)}</span>
            ${renderFieldActions(col.path)}
          </div>`
          )
          .join('')}
      </div>`
    )
    .join('');
}

function timelineStatusDot(status) {
  if (status === 'error') {
    return 'dot-bad';
  }
  if (status === 'warn') {
    return 'dot-warn';
  }
  if (status === 'ok') {
    return 'dot-ok';
  }
  return 'dot-idle';
}

function renderTimelineEmptyHint() {
  const ps = ui.pageSettings || {};
  const diag = getRuntimeContext().diag;
  const profile = ps.pageMeta?.profile || diag.profile || 'unknown';
  const pageCache = getPageEpochCount();
  const bgCount = appState?._bgEpochCount ?? appState?.epochs?.length ?? 0;
  const lines = [];

  if (!ps.bizDebug) {
    lines.push('bizDebug 未开启 → 设置里点「一键开启并刷新」。');
  } else if (pageCache > 0 && bgCount === 0) {
    lines.push(`页面已有 ${pageCache} 条 Epoch 但未进 Panel → 点左下角「重新同步 Panel」。`);
  } else if (profile === 'lowcode') {
    lines.push('当前为低代码取证线：visibleToUser（getDisable/model 终值）vs shadowStore。');
    lines.push('请确认：① stateScopeProfile=lowcode（或 auto 且 boName 已映射）② 扩展重载后 F5 单据页。');
    lines.push('hook 就绪后改表头字段或触发 doDispatch，应出现 Epoch；勿用销货单 refreshView 口径。');
    if (!diag.lowcodeViewModel) {
      lines.push('未检测到 MDF viewModel → 等页面渲染完后点「重新挂 Hook」，或 F5。');
    }
  } else {
    lines.push('当前为传统单据取证线：StateCollector / FormController.refreshView vs statePatches。');
    lines.push('init-full 发生在 hook 安装之前时会丢失（刷新后常见）。');
    lines.push('请确认：① 升级开关 ON  ② 先设场景  ③ 再刷新/重新进入新增页。');
    lines.push('或 hook 就绪后改任意表头字段，应至少出现 1 条 Epoch。');
    if (!diag.stateManager) {
      lines.push('当前未检测到 stateManager → 升级开关可能未开，或 ServicePlus 未加载。');
    }
  }

  return `<div class="empty timeline-empty-hint">
    <div>尚无 Epoch</div>
    <ul>${lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
    <div class="subtle">Console 搜 <code>[StateScope] Epoch</code>；页眉链状态 ✓ 只表示 hook 目标已找到，不代表已有 Epoch。</div>
  </div>`;
}

function renderTimelineList(epochs) {
  if (!epochs.length) {
    return renderTimelineEmptyHint();
  }

  return `<div class="timeline">${epochs
    .map((epoch, index) => {
      const prev = epochs[index + 1];
      const changed = epoch.counts?.changedSample || 0;
      const prevChanged = prev?.counts?.changedSample;
      let deltaHint = '';
      if (prevChanged != null && prevChanged !== changed) {
        const delta = changed - prevChanged;
        deltaHint = delta > 0 ? ` · 较上次 +${delta}` : ` · 较上次 ${delta}`;
      }
      const status = getEpochHealth(epoch).status;
      const mismatch = epoch.diffSummary?.logicMismatch || 0;
      const label =
        mismatch > 0 ? `${mismatch} mismatch`
        : changed > 0 ? `${changed} 字段变化`
        : '无变化';
      const active = epochIdsEqual(getSelectedEpoch()?.id, epoch.id) ? ' active' : '';

      return `<button type="button" class="tl-item${active}" data-select-epoch="${epoch.id}">
        <div class="tl-time">${esc(epoch.timeLabel || '—')}</div>
        <div class="tl-card">
          <div class="tl-title">#${epoch.id} ${esc(epoch.trigger)}</div>
          <div class="tl-meta">
            <span class="dot ${timelineStatusDot(status)}"></span>
            <span>${esc(label)}${esc(deltaHint)}</span>
            <span class="tl-tag">${changed}/${epoch.counts?.finalSnap || 0}</span>
            <span class="tl-tag">${epoch.phase === 'incremental' ? 'incr' : epoch.phase || 'incr'}</span>
          </div>
        </div>
      </button>`;
    })
    .join('')}</div>`;
}

function renderKeySummary(epoch) {
  if (!epoch) {
    const profile = ui.pageSettings?.pageMeta?.profile || getRuntimeContext().diag?.profile;
    if (profile === 'lowcode') {
      return '尚无 Epoch，请操作字段触发 doDispatch（低代码线，非 refreshView）。';
    }
    return '尚无 Epoch，请操作单据字段触发 refreshView（传统线）。';
  }
  const steps = epoch.scopeFlow || [];
  if (steps.length) {
    return steps.map((step) => step.detail).join(' → ');
  }
  return epoch.groupTitle || '—';
}

function renderDiffBadges(summary) {
  const s = summary || {};
  return `<div class="diff-badges">
    <span class="badge badge-ok">${s.ok || 0} ok</span>
    <span class="badge badge-bad">${s.logicMismatch || 0} mismatch</span>
    <span class="badge badge-warn">${s.legacyOnly || 0} legacy-only</span>
    <span class="badge badge-muted">${s.pending || 0} pending</span>
  </div>`;
}

function renderDiffCounters(summary) {
  const s = summary || {};
  return `<div class="diff-counter-grid">
    <div class="diff-counter ok"><div class="num">${s.ok || 0}</div><div class="label">ok</div></div>
    <div class="diff-counter bad"><div class="num">${s.logicMismatch || 0}</div><div class="label">logic-mismatch</div></div>
    <div class="diff-counter warn"><div class="num">${s.legacyOnly || 0}</div><div class="label">legacy-only</div></div>
    <div class="diff-counter"><div class="num">${s.pending || 0}</div><div class="label">pending</div></div>
  </div>`;
}

function renderActivationBanner(activation) {
  if (activation.level === 'on') {
    return '';
  }

  const hint = esc(activation.hint || '');
  const intro =
    activation.level === 'wait' ?
      `StateScope ${esc(activation.label)}：${hint}`
    : `StateScope 未激活：${hint}`;

  const note =
    activation.level === 'off' ?
      '<div class="subtle" style="margin-top:6px">一键开启只写入 localStorage，不会立刻挂载 injector；写入后必须刷新单据页。</div>'
    : '<div class="subtle" style="margin-top:6px">bizDebug 已开，刷新单据页后 StateScope 才会挂载到 presenter。</div>';

  const actions =
    activation.level === 'off' ?
      `<div class="banner-actions">
        <button type="button" class="btn primary" id="banner-enable-reload">一键开启并刷新</button>
        <button type="button" class="btn" id="banner-enable-debug">仅写入 bizDebug</button>
        <button type="button" class="btn" id="banner-reload-page">刷新单据页</button>
      </div>`
    : `<div class="banner-actions">
        <button type="button" class="btn primary" id="banner-reload-page">刷新单据页</button>
      </div>`;

  return `<div class="banner warn activation-banner">
    <div>${intro}</div>
    ${note}
    ${actions}
  </div>`;
}

function renderQuickActions() {
  return `<div class="quick-actions">
    <button type="button" class="btn" id="action-copy-diagnose">复制 diagnoseLastEpoch</button>
    <button type="button" class="btn" id="action-copy-filter">复制 Console 过滤词</button>
    <button type="button" class="btn" id="action-export-snapshot">导出当前 Epoch JSON</button>
  </div>`;
}

function renderSectionCard(id, title, summary, bodyHtml, expanded) {
  return `<div class="section-card">
    <div class="section-head clickable" data-toggle-section="${id}">
      <div>
        <div>${esc(title)}</div>
        <div class="section-summary">${esc(summary)}</div>
      </div>
      <div>${expanded ? '▼' : '▶'}</div>
    </div>
    <div class="section-body ${expanded ? '' : 'hidden'}">${bodyHtml}</div>
  </div>`;
}

function renderEpochDetailColumn(epoch, { showVerdict = false } = {}) {
  if (!epoch) {
    const profile = ui.pageSettings?.pageMeta?.profile || getRuntimeContext().diag?.profile;
    const hint =
      profile === 'lowcode' ?
        '选择 Timeline 中的 Epoch 查看详情（低代码：终值 vs shadowStore）'
      : '选择 Timeline 中的 Epoch 查看详情（传统：StateCollector vs statePatches）';
    return `<div class="empty">${hint}</div>`;
  }

  const changed = epoch.sections?.changedSet;
  const main = epoch.sections?.main;
  const detail = epoch.sections?.detail;
  const changedBody = renderChangedGroups({
    ...epoch,
    changedGroups: epoch.changedGroups || groupChangedFallback(epoch)
  });
  const mainBody = renderFlatRows(main?.rows, '无表头终态');
  const detailSummary = `${ui.detailAllColumns ? '全部列' : '仅变更列'} · ${(ui.detailAllColumns ? detail?.gridsAll : detail?.grids)?.length || 0} 行 Grid`;
  const detailBody = `<div class="toolbar">
      <label><input type="checkbox" id="detail-all-columns" ${ui.detailAllColumns ? 'checked' : ''} /> 全部列</label>
      <label><input type="checkbox" id="show-paths-detail" ${ui.showPaths ? 'checked' : ''} /> 显示 path</label>
    </div>${renderDetailGridsBody(epoch)}`;

  return `<div>
    <div class="detail-head">
      <div>
        <div class="detail-title">Epoch #${epoch.id} 详情</div>
        <div class="subtle">${esc(epoch.timeLabel || '')} · ${esc(epoch.trigger)} · ${esc(epoch.phase)}</div>
      </div>
      <button type="button" class="btn-mini" id="copy-epoch-json">复制 JSON</button>
    </div>
    ${showVerdict ? renderVerdict(getEpochHealth(epoch)) : ''}
    <div class="summary-text">${esc(renderKeySummary(epoch))}</div>
    ${renderSectionCard(
      'changedSet',
      `变更集字段终态 (${changed?.count || 0})`,
      `禁用 ${changed?.stats?.disabled || 0} / 可编辑 ${changed?.stats?.enabled || 0}`,
      `<div class="toolbar"><label><input type="checkbox" id="show-paths" ${ui.showPaths ? 'checked' : ''} /> 显示 path</label></div>${changedBody}`,
      ui.expanded.changedSet
    )}
    ${epoch.showMain ?
      renderSectionCard(
        'main',
        `表头全量终态 (${main?.count || 0})`,
        'path 平铺列表',
        mainBody,
        ui.expanded.main
      )
    : ''}
    ${epoch.showDetail ?
      renderSectionCard(
        'detail',
        `明细变更行终态 (${detail?.count || 0})`,
        detailSummary,
        detailBody,
        ui.expanded.detail
      )
    : ''}
    <div class="section-card" style="padding:12px">
      <div class="card-head">Diff 摘要 (allowlist)</div>
      ${renderDiffCounters(epoch.diffSummary)}
      <button type="button" class="btn-link" data-goto-tab="diff">打开 Diff 对比 Tab →</button>
    </div>
  </div>`;
}

function renderOverview() {
  const activation = getActivationState();
  const epoch = getSelectedEpoch();
  const epochs = appState?.epochs || [];

  if (activation.level !== 'on' && !epoch) {
    return `${renderActivationBanner(activation)}${renderQuickActions()}`;
  }

  const impact = getEpochImpact(epoch);

  return `${renderOverviewHero(epoch)}
  <div class="overview-grid">
    <div class="card">
      <div class="card-head">当前状态概览</div>
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">Epoch</div><div class="kpi-value">#${epoch?.id || '—'}</div></div>
        <div class="kpi"><div class="kpi-label">变更集</div><div class="kpi-value">${impact.changed}</div></div>
        <div class="kpi"><div class="kpi-label">快照</div><div class="kpi-value">${impact.final}</div></div>
      </div>
      ${epoch ? renderDiffBadges(epoch.diffSummary) : ''}
      <div class="card-head">本次 Epoch 关键摘要</div>
      <div class="summary-text">${esc(renderKeySummary(epoch))}</div>
      ${renderQuickActions()}
    </div>
    <div class="card">
      <div class="card-head">最近 Epoch Timeline</div>
      ${renderTimelineList(epochs)}
    </div>
    <div class="card">${renderEpochDetailColumn(epoch, { showVerdict: false })}</div>
  </div>
  <div class="banner info">${esc(getAllowlistBannerText())}</div>
  <div class="hint-cards">
    <div class="hint-card"><strong>表头展示</strong>path 平铺，适合核对表头字段终态。</div>
    <div class="hint-card"><strong>明细展示</strong>Grid 视图，默认仅变更列，可展开全部列。</div>
    <div class="hint-card"><strong>Diff 原则</strong>优先关注 logic-mismatch；pending 表示 new 轨未接入。</div>
  </div>`;
}

function renderTimelinePage() {
  const epochs = appState?.epochs || [];
  const epoch = getSelectedEpoch();

  return `<div class="timeline-page">
    <div class="card">
      <div class="card-head">Epoch Timeline</div>
      ${renderTimelineList(epochs)}
    </div>
    <div class="card">${renderEpochDetailColumn(epoch, { showVerdict: true })}</div>
  </div>`;
}

function renderDiffTab() {
  const epoch = getSelectedEpoch();
  if (!epoch) {
    return '<div class="empty">尚无 Epoch 或请先选择 Timeline 条目。</div>';
  }

  return `<div class="diff-page">
    <div class="card">
      <div class="card-head">Diff 对比 · Epoch #${epoch.id}</div>
      ${renderDiffCounters(epoch.diffSummary)}
      ${renderDiffLayer(epoch)}
    </div>
  </div>`;
}

function updateIssuesNavBadge() {
  const badge = document.getElementById('issues-nav-badge');
  if (!badge) {
    return;
  }
  const open = (appState?.issues || []).filter((item) => item.status === 'open').length;
  if (open > 0) {
    badge.textContent = String(open);
    badge.className = 'nav-badge nav-badge-bad';
  } else {
    badge.textContent = '';
    badge.className = 'nav-badge';
  }
}

function buildRefreshFingerprint() {
  const epoch = getSelectedEpoch();
  const activation = getActivationState();
  const report = getCutoverReport();
  return [
    ui.tab,
    ui.selectedEpochId ?? '',
    appState?.epochs?.length ?? 0,
    appState?.updatedAt ?? 0,
    activation.level,
    ui.pageSettings?.bizDebug,
    ui.pageSettings?.stateScopeInstalled,
    ui.pageSettings?.allowlistActive,
    ui.pageSettings?.allowlistBoName,
    ui.pageSettings?.allowlistVersion,
    ui.allowlistBinding?.boName,
    ui.allowlistBinding?.version,
    ui.pageSettings?.pageSyncEpochCount,
    ui.pageSettings?.pageSyncSummary?.latestEpochId ?? '',
    ui.pageSettings?.pageSyncSummary?.latestStartedAt ?? '',
    epoch?.id ?? '',
    epoch?.startedAt ?? '',
    epoch?.diffSummary?.logicMismatch ?? '',
    report?.updatedAt ?? 0,
    (appState?.issues || []).length,
    appState?.scenarioReport?.catalogVersion ?? '',
    Object.keys(appState?.scenarioReport?.scenarios || {}).length,
    appState?.scenarioReport?.updatedAt ?? 0,
    appState?.scenarioReport?.summary?.markedComplete ?? 0,
    ui.scenarioCatalog?.version ?? '',
    ui.tab === 'scenarios' ? 'scenarios' : '',
    JSON.stringify(ui.expanded)
  ].join('|');
}

function renderMainPanel() {
  const root = document.getElementById('app');
  if (!root) {
    return;
  }

  if (ui.tab === 'settings') {
    root.innerHTML = renderSettings();
  } else if (ui.tab === 'timeline') {
    root.innerHTML = renderTimelinePage();
  } else if (ui.tab === 'diff') {
    root.innerHTML = renderDiffTab();
  } else if (ui.tab === 'cutover') {
    root.innerHTML = renderCutoverTab();
  } else if (ui.tab === 'scenarios') {
    root.innerHTML = window.StateScopeScenarioUI ?
        window.StateScopeScenarioUI.renderScenarioTab(getPanelCtx())
      : '<div class="empty">场景 UI 未加载</div>';
  } else if (ui.tab === 'issues') {
    root.innerHTML = window.StateScopeIssuesUI ?
        window.StateScopeIssuesUI.renderIssuesTab(getIssuesCtx())
      : '<div class="empty">Issues UI 未加载</div>';
  } else {
    root.innerHTML = renderOverview();
  }
}

function renderApp() {
  renderChrome();
  updateCutoverNavBadge();
  updateIssuesNavBadge();
  window.StateScopeScenarioUI?.updateNavBadge(getPanelCtx());
  renderMainPanel();
}

async function exportDiagnosticJson() {
  const epoch = getSelectedEpoch();
  const { diag, meta } = getRuntimeContext();
  const payload = {
    tabId,
    runtime: { diagnostics: diag, meta },
    selectedEpochId: epoch?.id || null,
    epochCount: appState?.epochs?.length || 0,
    epoch: epoch || null
  };
  await copyText(JSON.stringify(payload, null, 2));
}

async function copyDiagnoseFromPage() {
  const response = await evalInPage(`(function () {
    if (!window.__StateScope__?.diagnoseLastEpoch) return { ok: false, error: 'API 不可用' };
    return { ok: true, result: window.__StateScope__.diagnoseLastEpoch() };
  })()`);
  if (response.ok && response.result?.ok !== false) {
    await copyText(JSON.stringify(response.result, null, 2));
  } else {
    const epoch = getSelectedEpoch();
    if (epoch) {
      await copyText(JSON.stringify({ epochId: epoch.id, diffSummary: epoch.diffSummary, counts: epoch.counts }, null, 2));
    } else {
      showToast(response.result?.error || '尚无 diagnose 数据');
    }
  }
}

function filterDiffRows(rows, hasNewChain) {
  return (rows || []).filter((row) => {
    if (ui.diffOnlyMismatch && hasNewChain && row.severity === 'ok') {
      return false;
    }
    if (!ui.diffSearch) {
      return true;
    }
    const q = ui.diffSearch.toLowerCase();
    return (
      row.path.toLowerCase().includes(q) ||
      String(row.displayName || '').toLowerCase().includes(q)
    );
  });
}

function renderDiffLayer(epoch) {
  const profile = epoch?.meta?.profile || ui.pageSettings?.pageMeta?.profile || 'traditional';
  const banner = epoch.hasNewChain ?
    ''
  : profile === 'lowcode' ?
      `<div class="banner warn">shadow 轨未接入；以下为 getDisable/终值预览。需 M-MDF-1～3 applyStatePatches(shadow) 合入。</div>`
    : `<div class="banner warn">new 轨未接入；以下为 old 预览，结果为「待接入」。</div>`;
  const groups = epoch.diffGroups || { main: [], details: [] };
  const mainRows = filterDiffRows(groups.main, epoch.hasNewChain);
  const focusPath = ui.diffFocusPath;

  const renderRows = (rows) => {
    if (!rows.length) {
      return '<div class="empty">无匹配 Diff</div>';
    }
    return rows
      .map((row) => {
        const focused = focusPath && row.path === focusPath ? ' focused' : '';
        return `<div class="field-row${focused}">
          <div class="field-main">
            <div class="field-name">${esc(row.displayName || row.path)}</div>
            <div class="field-path">${esc(row.path)}${row.gridHint ? ` · ${esc(row.gridHint)}` : ''}</div>
          </div>
          <div class="subtle">${esc(row.oldLabel || '—')} → ${esc(row.newLabel || '—')}</div>
          <span class="chip">${esc(row.resultLabel || row.severity)}</span>
          ${renderFieldActions(row.path)}
        </div>`;
      })
      .join('');
  };

  const detailBlocks = (groups.details || [])
    .map((group) => {
      const rows = filterDiffRows(group.rows, epoch.hasNewChain);
      if (!rows.length) {
        return '';
      }
      return `<div class="group-card">
        <div class="group-title">${esc(group.body)} · ${esc(group.rowLabel)}</div>
        ${renderRows(rows)}
      </div>`;
    })
    .join('');

  return `${banner}
    <div class="toolbar">
      <label><input type="checkbox" id="diff-only-mismatch" ${ui.diffOnlyMismatch ? 'checked' : ''} /> 仅 mismatch</label>
      <input type="search" id="diff-search" placeholder="搜索字段…" value="${esc(ui.diffSearch)}" />
    </div>
    <div class="group-card"><div class="group-title">表头</div>${renderRows(mainRows)}</div>
    ${detailBlocks}`;
}

function renderFlatRows(rows, emptyText) {
  if (!rows?.length) {
    return `<div class="empty">${esc(emptyText)}</div>`;
  }
  return rows
    .map(
      (row) => `<div class="field-row ${row.changed ? 'changed' : ''}">
        <div class="field-main">
          <div class="field-name">${esc(row.parsed?.field || row.path.split('.').slice(-2, -1)[0] || row.path)}</div>
          ${ui.showPaths ? `<div class="field-path">${esc(row.path)}</div>` : ''}
        </div>
        <span class="chip ${row.label === '可编辑' ? 'on' : 'off'}">${esc(row.label)}</span>
        ${renderFieldActions(row.path)}
      </div>`
    )
    .join('');
}

function getAllowlistBannerText() {
  const epoch = getSelectedEpoch();
  if (epoch?.allowlistMeta?.fieldCount) {
    return `Diff 按 allowlist 过滤（${epoch.allowlistMeta.fieldCount} 字段）；可在「设置」取消恢复全量。`;
  }
  return '当前无 allowlist，Diff 对比全部捕获字段；切流报告需在设置中加载 allowlist。';
}

function renderAllowlistCatalog(ps) {
  const fields = ps?.allowlistFields || [];
  if (!fields.length) {
    return '<div class="empty subtle">allowlist 未绑定或无字段。绑定后此处显示 JSON 中的完整字段清单（无需先操作单据）。</div>';
  }

  const note = ps.allowlistNote ?
      `<div class="subtle allowlist-note">${esc(ps.allowlistNote)}</div>`
    : '';

  return `${note}<div class="cutover-table-wrap allowlist-catalog">
    <table class="cutover-table">
      <thead>
        <tr>
          <th>#</th>
          <th>path</th>
          <th>stateType</th>
          <th>configKey</th>
          <th>oldEntry</th>
        </tr>
      </thead>
      <tbody>
        ${fields
          .map(
            (item, index) => `<tr>
              <td>${index + 1}</td>
              <td><div class="field-name">${esc(item.path)}</div></td>
              <td>${esc(item.stateType || '—')}</td>
              <td>${esc(item.configKey || '—')}</td>
              <td class="field-path">${esc(item.oldEntry || '—')}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

function renderSettings() {
  const ps = ui.pageSettings || {};
  const rows = DEBUG_KEYS.map(({ key, label, desc }) => {
    const on = !!ps[key];
    return `<div class="settings-row">
      <div><div>${esc(label)}</div><div class="subtle">${esc(desc)}</div></div>
      <span class="chip ${on ? 'on' : 'off'}">${on ? '已开启' : '未开启'}</span>
    </div>`;
  }).join('');

  const allowlistStatus = ps.allowlistActive ?
      `已绑定 · ${ps.allowlistFieldCount || 0} 字段${ps.allowlistVersion ? ` · v${ps.allowlistVersion}` : ''}`
    : ps.loadedAllowlistKeys?.length ?
        `已写入 cache [${ps.loadedAllowlistKeys.join(', ')}] 但未匹配当前 boName`
      : '未绑定（Diff 全量）';
  const autoAllowlistOn = ps.stateScopeAutoAllowlist !== false;
  const profileMode = ps.stateScopeProfile || 'auto';
  const profileDet = ps.profileDetection || {};
  const profileRows = PROFILE_OPTIONS.map(
    (opt) => `<option value="${esc(opt.value)}" ${profileMode === opt.value ? 'selected' : ''}>${esc(opt.label)}</option>`
  ).join('');

  const msg = ui.settingsMessage ?
      `<div class="banner ${ui.settingsMessage.includes('失败') || ui.settingsMessage.includes('未找到') ? 'warn' : 'info'}">${esc(ui.settingsMessage)}</div>`
    : '';

  return `${msg}<div class="card">
    <h3>DevTools 设置</h3>
    <div class="settings-actions">
      <button type="button" class="btn primary" id="enable-all-debug">一键开启 bizDebug</button>
      <button type="button" class="btn primary" id="enable-and-reload">一键开启并刷新</button>
      <button type="button" class="btn" id="reload-page">刷新单据页</button>
      <button type="button" class="btn" id="rediscover-hooks">重新挂 Hook</button>
    </div>
    ${rows}
  </div>
  <div class="card">
    <h3>验证 Profile</h3>
    <div class="settings-row">
      <div>
        <div>当前模式</div>
        <div class="subtle">${esc(profileDet.reason || '—')}${profileDet.confidence ? ` · 置信度 ${esc(profileDet.confidence)}` : ''}</div>
      </div>
      <span class="chip on">${esc(profileDet.effectiveProfile || profileDet.profile || ps.pageMeta?.profile || '—')}</span>
    </div>
    <div class="settings-form">
      <label>
        stateScopeProfile
        <select id="profile-mode-select">${profileRows}</select>
      </label>
      <div class="subtle" style="margin-top:6px">切换后需刷新单据页以重装 hook（与 bizDebug 相同）。</div>
    </div>
    <div class="settings-actions">
      <button type="button" class="btn primary" id="apply-profile-mode">应用 Profile 并刷新</button>
    </div>
  </div>
  <div class="card">
    <h3>Allowlist</h3>
    <div class="settings-row">
      <div>
        <div>当前状态</div>
        <div class="subtle">${esc(allowlistStatus)}</div>
      </div>
      <span class="chip ${ps.allowlistActive ? 'on' : 'off'}">${ps.allowlistActive ? '过滤中' : '全量 Diff'}</span>
    </div>
    <div class="settings-row">
      <div>
        <div>stateScopeAutoAllowlist</div>
        <div class="subtle">关闭后不再自动加载 allowlists/*.json，并清除当前过滤</div>
      </div>
      <span class="chip ${autoAllowlistOn ? 'on' : 'off'}">${autoAllowlistOn ? '自动加载' : '已关闭'}</span>
    </div>
    <div class="settings-actions">
      <button type="button" class="btn" id="clear-allowlist">取消 allowlist（恢复全量 Diff）</button>
      <button type="button" class="btn" id="toggle-auto-allowlist">${autoAllowlistOn ? '关闭自动加载' : '开启自动加载'}</button>
      <button type="button" class="btn" id="resync-allowlist-settings">重新加载 allowlist</button>
    </div>
    <div class="allowlist-catalog-head">
      <div>字段清单（${ps.allowlistFieldCount || 0}）</div>
      <div class="subtle">${ps.allowlistBoName ? esc(ps.allowlistBoName) : '—'}${ps.allowlistVersion ? ` · v${esc(ps.allowlistVersion)}` : ''}</div>
    </div>
    ${renderAllowlistCatalog(ps)}
  </div>
  ${window.StateScopeIssuesUI ? window.StateScopeIssuesUI.renderJiraSettings(getIssuesCtx()) : ''}`;
}

async function selectEpoch(epochId) {
  const id = normalizeEpochId(epochId);
  ui.selectedEpochId = id;
  ui.epochFollowLatest = epochIdsEqual(id, getLatestEpochId());
  if (appState) {
    appState.selectedEpochId = id;
  }
  await safeRuntimeMessage({ type: 'SS_SELECT_EPOCH', tabId, epochId: id });
}

function bindAppEvents() {
  const root = document.getElementById('app');
  if (!root) {
    return;
  }

  document.getElementById('copy-diagnostic-info')?.addEventListener('click', exportDiagnosticJson);
  document.getElementById('resync-panel-data')?.addEventListener('click', resyncPanelFromPage);

  root.querySelectorAll('[data-goto-tab]').forEach((el) => {
    el.addEventListener('click', async () => {
      const focusPath = el.getAttribute('data-focus-path');
      if (focusPath) {
        ui.diffOnlyMismatch = false;
        ui.diffFocusPath = focusPath;
      }
      ui.tab = el.getAttribute('data-goto-tab');
      syncNavActive();
      if (ui.tab === 'settings') {
        await readPageSettings();
      }
      renderApp();
      bindAppEvents();
      if (focusPath && ui.tab === 'diff') {
        requestAnimationFrame(() => {
          document.querySelector('.field-row.focused')?.scrollIntoView({ block: 'center' });
        });
      }
    });
  });

  root.querySelectorAll('[data-toggle-section]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-toggle-section');
      ui.expanded[key] = !ui.expanded[key];
      renderApp();
      bindAppEvents();
    });
  });

  root.querySelectorAll('[data-copy-path]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      copyText(el.getAttribute('data-copy-path'));
    });
  });

  root.querySelectorAll('[data-copy-json]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      const path = el.getAttribute('data-copy-json');
      const epoch = getSelectedEpoch();
      const pools = [
        ...(epoch?.sections?.changedSet?.rows || []),
        ...(epoch?.sections?.main?.rows || []),
        ...(epoch?.diffs || [])
      ];
      const hit = pools.find((row) => row.path === path);
      const value = hit?.value ?? hit?.old;
      copyText(JSON.stringify({ path, value }, null, 2));
    });
  });

  document.getElementById('action-copy-diagnose')?.addEventListener('click', copyDiagnoseFromPage);
  document.getElementById('action-copy-filter')?.addEventListener('click', () => copyText('StateScope'));
  document.getElementById('action-export-snapshot')?.addEventListener('click', exportDiagnosticJson);
  document.getElementById('copy-epoch-json')?.addEventListener('click', exportDiagnosticJson);

  const showPaths = document.getElementById('show-paths');
  if (showPaths) {
    showPaths.addEventListener('change', () => {
      ui.showPaths = showPaths.checked;
      renderApp();
      bindAppEvents();
    });
  }

  const showPathsDetail = document.getElementById('show-paths-detail');
  if (showPathsDetail) {
    showPathsDetail.addEventListener('change', () => {
      ui.showPaths = showPathsDetail.checked;
      renderApp();
      bindAppEvents();
    });
  }

  const detailAll = document.getElementById('detail-all-columns');
  if (detailAll) {
    detailAll.addEventListener('change', () => {
      ui.detailAllColumns = detailAll.checked;
      ui.expanded.detail = true;
      renderApp();
      bindAppEvents();
    });
  }

  const diffOnly = document.getElementById('diff-only-mismatch');
  if (diffOnly) {
    diffOnly.addEventListener('change', () => {
      ui.diffOnlyMismatch = diffOnly.checked;
      renderApp();
      bindAppEvents();
    });
  }

  const diffSearch = document.getElementById('diff-search');
  if (diffSearch) {
    diffSearch.addEventListener('input', () => {
      ui.diffSearch = diffSearch.value;
      renderApp();
      bindAppEvents();
    });
  }

  document.getElementById('banner-enable-reload')?.addEventListener('click', async () => {
    await enableAndReloadPage();
    renderApp();
    bindAppEvents();
  });
  document.getElementById('banner-enable-debug')?.addEventListener('click', async () => {
    await enableAllDebugSettings();
    renderApp();
    bindAppEvents();
  });
  document.getElementById('banner-reload-page')?.addEventListener('click', reloadInspectedPage);

  const enableAll = document.getElementById('enable-all-debug');
  if (enableAll) {
    enableAll.addEventListener('click', async () => {
      await enableAllDebugSettings();
      renderApp();
      bindAppEvents();
    });
  }

  document.getElementById('enable-and-reload')?.addEventListener('click', async () => {
    await enableAndReloadPage();
    renderApp();
    bindAppEvents();
  });

  document.getElementById('reload-page')?.addEventListener('click', reloadInspectedPage);

  document.getElementById('apply-profile-mode')?.addEventListener('click', async () => {
    const mode = document.getElementById('profile-mode-select')?.value || 'auto';
    await evalInPage(`(function () {
      if (window.__StateScope__?.setProfileMode) {
        window.__StateScope__.setProfileMode(${JSON.stringify(mode)});
      } else {
        localStorage.setItem('stateScopeProfile', ${JSON.stringify(mode)});
      }
      localStorage.setItem('bizDebug', 'true');
      location.reload();
      return { ok: true };
    })()`);
    ui.settingsMessage = `Profile 已设为 ${mode}，正在刷新单据页…`;
    showToast(ui.settingsMessage);
  });

  document.getElementById('rediscover-hooks')?.addEventListener('click', async () => {
    const response = await evalInPage(`(function () {
      if (!window.__StateScope__?.rediscover) {
        return { ok: false, error: 'injector 未就绪，请先刷新单据页' };
      }
      const meta = window.__StateScope__.rediscover();
      window.__StateScope__.syncPanelState?.();
      return {
        ok: true,
        boName: meta?.boName,
        stateManager: !!meta?.diagnostics?.stateManager,
        formController: !!meta?.diagnostics?.formController
      };
    })()`);
    if (response.ok && response.result?.ok !== false) {
      const profile = ui.pageSettings?.pageMeta?.profile || '—';
      ui.settingsMessage =
        profile === 'lowcode' ?
          `Hook 已重挂（lowcode）：boName=${response.result.boName || '—'}。请改表头字段触发 doDispatch。`
        : `Hook 已重挂（traditional）：stateManager=${response.result.stateManager ? '✓' : '✗'} formController=${response.result.formController ? '✓' : '✗'}。请重新进入新增页或改一个字段。`;
      showToast('Hook 已重新挂载');
    } else {
      ui.settingsMessage = response.result?.error || response.error || '重新挂 Hook 失败';
      showToast(ui.settingsMessage);
    }
    await resyncPanelFromPage();
    renderApp();
    bindAppEvents();
  });

  document.getElementById('export-cutover-json')?.addEventListener('click', exportCutoverJson);
  document.getElementById('export-cutover-csv')?.addEventListener('click', exportCutoverCsv);
  document.getElementById('reset-cutover')?.addEventListener('click', resetCutoverReport);
  document.getElementById('resync-allowlist')?.addEventListener('click', async () => {
    ui.lastSyncedBoName = null;
    const result = await syncAllowlistToPage({ force: true });
    await readPageSettings();
    lastRefreshFingerprint = '';
    showToast(result.ok ? ui.settingsMessage || 'allowlist 已绑定' : ui.settingsMessage || 'allowlist 加载失败');
    renderApp();
    bindAppEvents();
  });

  document.getElementById('clear-allowlist')?.addEventListener('click', async () => {
    await clearAllowlistOnPage();
    renderApp();
    bindAppEvents();
  });

  document.getElementById('toggle-auto-allowlist')?.addEventListener('click', async () => {
    const enabled = ui.pageSettings?.stateScopeAutoAllowlist === false;
    await setAutoAllowlistOnPage(enabled);
    renderApp();
    bindAppEvents();
  });

  document.getElementById('resync-allowlist-settings')?.addEventListener('click', async () => {
    ui.lastSyncedBoName = null;
    const result = await syncAllowlistToPage({ force: true });
    await readPageSettings();
    lastRefreshFingerprint = '';
    if (!result.ok && !ui.settingsMessage) {
      ui.settingsMessage = 'allowlist 加载失败，请确认扩展已 reload 且 allowlists/GoodsIssue.v1.json 存在';
    }
    renderApp();
    bindAppEvents();
  });

  window.StateScopeIssuesUI?.bindIssuesEvents(getPanelCtx());
  window.StateScopeIssuesUI?.bindJiraSettingsEvents(getPanelCtx());
  window.StateScopeScenarioUI?.bindScenarioEvents(getPanelCtx());
}

function syncNavActive() {
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-tab') === ui.tab);
  });
}

function bindTabs() {
  document.querySelectorAll('.nav-item').forEach((tab) => {
    tab.addEventListener('click', async () => {
      ui.tab = tab.getAttribute('data-tab');
      syncNavActive();
      await refresh({ force: true });
    });
  });
}

function shouldLoadFullPageSync(force) {
  if (force) {
    return true;
  }
  if (!ui.pageSettings?.stateScopeInstalled) {
    return false;
  }
  const summaryCount = ui.pageSettings?.pageSyncEpochCount ?? 0;
  if (summaryCount !== lastPageSyncEpochCount) {
    return true;
  }
  const latestId = ui.pageSettings?.pageSyncSummary?.latestEpochId ?? null;
  if (latestId != null && latestId !== lastSyncedLatestEpochId) {
    return true;
  }
  const needsEpochUi = ['overview', 'timeline', 'diff'].includes(ui.tab);
  if (!needsEpochUi) {
    return false;
  }
  return !ui.pageSettings?.pageSync?.epochs?.length || !(appState?.epochs?.length);
}

async function refresh({ force = false } = {}) {
  if (refreshInFlight) {
    pendingRefresh = true;
    return;
  }
  refreshInFlight = true;
  try {
    await readPageSettings({ includeAllowlistFields: ui.tab === 'settings' });

    if (shouldLoadFullPageSync(force) && ui.pageSettings?.stateScopeInstalled) {
      await readPageSyncFull();
    }

    await loadState();
    applyPageSyncToAppState();

    await syncFromPageIfNeeded();
    await loadState();
    applyPageSyncToAppState();
    maybeSelectLatestEpoch();

    if (window.StateScopeIssuesUI) {
      await window.StateScopeIssuesUI.readScenarioFromPage(getPanelCtx());
    }
    await ensureLocalScenarioCatalog();
    await syncAllowlistToPage();
    await syncScenarioCatalogToBackground();
    hydrateScenarioReportFromCatalog();
    if (ui.tab === 'scenarios') {
      lastRefreshFingerprint = '';
    }

    renderChrome();
    updateCutoverNavBadge();
    updateIssuesNavBadge();
    window.StateScopeScenarioUI?.updateNavBadge(getPanelCtx());

    const fp = buildRefreshFingerprint();
    if (force || fp !== lastRefreshFingerprint) {
      lastRefreshFingerprint = fp;
      renderMainPanel();
      bindAppEvents();
    }
  } finally {
    refreshInFlight = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      setTimeout(() => {
        refresh({ force: true });
      }, 0);
    }
  }
}

function bindEpochSelection() {
  const root = document.getElementById('app');
  if (!root || root.__stateScopeEpochBound) {
    return;
  }
  root.__stateScopeEpochBound = true;
  root.addEventListener('click', (event) => {
    const el = event.target.closest('[data-select-epoch]');
    if (!el) {
      return;
    }
    event.preventDefault();
    void (async () => {
      await selectEpoch(el.getAttribute('data-select-epoch'));
      lastRefreshFingerprint = '';
      renderApp();
      bindAppEvents();
    })();
  });
}

function init() {
  tabId = chrome.devtools?.inspectedWindow?.tabId ?? null;
  bindTabs();
  bindEpochSelection();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SS_STATE_UPDATED' && message.tabId === tabId) {
      refresh();
    }
  });

  refresh({ force: true });
  refreshTimerId = setInterval(() => {
    if (document.hidden || runtimeMessageFailures >= MAX_RUNTIME_MESSAGE_FAILURES) {
      return;
    }
    refresh();
  }, PANEL_REFRESH_MS);
}

init();
