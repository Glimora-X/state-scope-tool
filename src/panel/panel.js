const PANEL_VERSION = '0.8.35';

const CONSOLE_FILTER_PRESETS = [
  { id: 'action-copy-filter-all', label: 'StateScope', filter: 'StateScope' },
  { id: 'action-copy-filter-epoch', label: 'Epoch', filter: 'StateScope Epoch' },
  { id: 'action-copy-filter-scope', label: 'scope', filter: 'scope:' }
];

const ZH = window.StateScopeZh?.ZH || { epoch: '观测轮次', epochTimeline: '观测时间线' };
const severityZh = window.StateScopeZh?.severityZh || ((s) => s || '—');
const epochLabel = window.StateScopeZh?.epochLabel || ((id) => (id == null ? ZH.epoch : `${ZH.epoch} #${id}`));
const SHADOW_STORE_MISSING = window.StateScopeZh?.SHADOW_STORE_MISSING || {
  short: '影子未写入',
  headline: '框架已采到升级前；影子存储未写入',
  subline: 'statePatches 可能已算完，但 shadowStore 无该字段终态（非字段清单/采集框架问题）',
  bannerLowcode:
    '框架正常：已采到升级前（用户所见）。问题在存储：升级后 shadowStore 未写入。statePatches 有值也不算接入，须 applyStatePatches(shadow) 落盘。',
  bannerTraditional:
    '框架正常：已采到升级前。问题在存储：升级后结果未写入，当前仅升级前预览。'
};
const DIFF_COUNTER_ZH = window.StateScopeZh?.DIFF_COUNTER_ZH || {
  ok: '升级前后一致',
  logicMismatch: '升级前后不一致',
  legacyOnly: '未升级',
  newOnly: '仅升级后',
  pending: '影子未写入',
  total: '合计'
};

/** Panel eval 中解析 __StateScope__（兼容 iframe / early API） */
const RESOLVE_STATE_SCOPE = `function __ssResolve() {
  var api = window.__StateScope__;
  if (api && api.version) return api;
  try {
    var topApi = window.top && window.top.__StateScope__;
    if (topApi && topApi.version) return topApi;
  } catch (e) {}
  return null;
}`;

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
let pendingRefreshForce = false;
let stateUpdatedRefreshTimer = null;
let lastFullPageSyncAt = 0;
const FULL_PAGE_SYNC_MIN_MS = 1200;
let lastPageSyncEpochCount = 0;
/** 已拉全量 pageSync 的最新 epoch id（勿与「跟随时选中」混用） */
let lastPayloadSyncedLatestEpochId = null;
/** UI 跟随时选中用的最新 epoch id */
let lastFollowedLatestEpochId = null;
/** 上次已用 epochs 重算场景累计的指纹 */
let lastScenarioFromEpochsKey = '';
let refreshTimerId = null;
let runtimeMessageFailures = 0;
const MAX_RUNTIME_MESSAGE_FAILURES = 3;
/** 推送为主；定时仅作兜底心跳，不再 2.5s 狂拉 */
const PANEL_REFRESH_MS = 15000;
const PANEL_REFRESH_HIDDEN_MS = 30000;
/** 用户划选文本时推迟整页重绘 */
let deferredPanelRedraw = false;
let pendingRefreshReason = 'timer';

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
  if (
    tags.some(
      (tag) =>
        tag.startsWith('gi-') ||
        tag.startsWith('oi-') ||
        tag.startsWith('os-') ||
        /^oi-s\d+/i.test(tag) ||
        /^os-s\d+/i.test(tag) ||
        /^s\d+$/i.test(tag)
    )
  ) {
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
  // 仅当两侧都有 catalogEpoch 且不一致时禁止继承；缺字段视为同包（兼容旧会话）
  const bothHaveEpoch = !!(report?.catalogEpoch && catalog.catalogEpoch);
  const epochChanged = bothHaveEpoch && report.catalogEpoch !== catalog.catalogEpoch;
  const sameBoVersion =
    !!report &&
    (!report.boName || !catalog.boName || report.boName === catalog.boName) &&
    (!report.catalogVersion || !catalog.version || report.catalogVersion === catalog.version);
  const inherit = report && !epochChanged && (bothHaveEpoch || sameBoVersion) ? report : null;
  const scenarios = {};
  const sorted = [...catalog.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const meta of sorted) {
    scenarios[meta.tag] = buildScenarioRecordFromMeta(meta, inherit?.scenarios?.[meta.tag]);
  }
  const list = Object.values(scenarios);
  const summary = {
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
    catalogEpoch: catalog.catalogEpoch || null,
    catalogSource: catalog.source || report?.catalogSource || null,
    catalogTitle: catalog.title || report?.catalogTitle || null,
    allowlistVersion: catalog.allowlistVersion || report?.allowlistVersion || null,
    hasNewChainObserved: inherit?.hasNewChainObserved || false,
    ignoreEpochsBefore: inherit?.ignoreEpochsBefore || 0,
    updatedAt: Date.now(),
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
  const report = appState.scenarioReport;
  const epochChanged =
    ui.scenarioCatalog.catalogEpoch &&
    report?.catalogEpoch &&
    ui.scenarioCatalog.catalogEpoch !== report.catalogEpoch;
  if (isLegacyScenarioReport(report) || !report || epochChanged) {
    appState.scenarioReport = mergeScenarioCatalogIntoReport(ui.scenarioCatalog, report);
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
  const nextKey = catalogSyncKey(catalog);
  const keyChanged = nextKey !== ui.lastSyncedScenarioCatalogKey;
  ui.scenarioCatalog = catalog;
  if (!appState) {
    appState = { runtime: null, epochs: [], selectedEpochId: null, issues: [], settings: {} };
  }
  // 仅目录身份变化时重挂骨架；每次 loadState 都 merge 会抹掉 SW 已累计进度并卡刷新
  if (keyChanged || !appState.scenarioReport?.scenarios || !Object.keys(appState.scenarioReport.scenarios).length) {
    appState.scenarioReport = mergeScenarioCatalogIntoReport(catalog, appState.scenarioReport);
  } else if (!appState.scenarioReport.catalogEpoch && catalog.catalogEpoch) {
    appState.scenarioReport.catalogEpoch = catalog.catalogEpoch;
    appState.scenarioReport.catalogSource = catalog.source || appState.scenarioReport.catalogSource;
  }
  ui.lastSyncedScenarioCatalogKey = nextKey;
  const firstTag = [...catalog.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag;
  if (firstTag && (!ui.selectedScenarioTag || !catalog.scenarios.some((s) => s.tag === ui.selectedScenarioTag))) {
    ui.selectedScenarioTag = firstTag;
  }
  if (keyChanged) {
    lastRefreshFingerprint = '';
  }
  return appState.scenarioReport;
}

/** 对账键：catalogEpoch + source（① 与 ② 内容相同也不得 skip） */
function catalogSyncKey(pack) {
  if (!pack) {
    return '';
  }
  const epoch = pack.catalogEpoch || scenarioPackFingerprint(pack);
  return `${epoch}|${pack.source || ''}`;
}

/** panel 未打包 import；优先用 normalize 挂上的 catalogEpoch */
function scenarioPackFingerprint(pack) {
  if (pack?.catalogEpoch) {
    return pack.catalogEpoch;
  }
  if (!pack?.scenarios?.length) {
    return '';
  }
  const ids = pack.scenarios
    .map((item) => item.tag || item.id || item.group || '')
    .join(',');
  return `${pack.boName || ''}|${pack.version || ''}|${pack.scenarios.length}|${ids}`;
}

async function pullScenarioCatalogFromPage(boName) {
  const response = await evalInPage(`(function () {
    ${RESOLVE_STATE_SCOPE}
    var ss = __ssResolve();
    var bo = ${JSON.stringify(boName || '')};
    var raw = (window.__STATE_SCOPE_SCENARIOS__ && bo)
      ? window.__STATE_SCOPE_SCENARIOS__[bo]
      : null;
    var pack = ss && ss.getScenarioCatalogPack ? ss.getScenarioCatalogPack(bo || undefined) : null;
    return {
      raw: raw || null,
      pack: pack || null,
      source: (pack && pack.source) || (raw ? 'window-registry' : (pack ? 'page' : ''))
    };
  })()`);
  if (!response.ok) {
    return null;
  }
  const result = response.result;
  const pack = result?.pack || null;
  if (!pack?.scenarios?.length) {
    return null;
  }
  return {
    pack,
    raw: result.raw,
    source: result.source || pack.source || 'page',
    fingerprint: catalogSyncKey(pack)
  };
}

function slimEpochForBackground(epoch) {
  if (!epoch || epoch.id == null) {
    return null;
  }
  // 禁止夹带 diffs：大包会导致 SS_BULK_SYNC 后 GET_STATE 失败，场景永远不刷新
  return {
    id: typeof epoch.id === 'number' ? epoch.id : Number(epoch.id) || epoch.id,
    trigger: epoch.trigger || '',
    phase: epoch.phase || '',
    startedAt: epoch.startedAt || 0,
    timeLabel: epoch.timeLabel || '',
    hasNewChain: !!epoch.hasNewChain,
    allowlistMeta: epoch.allowlistMeta || null,
    allowlistFieldResults: Array.isArray(epoch.allowlistFieldResults)
      ? epoch.allowlistFieldResults
      : [],
    diffSummary: epoch.diffSummary || null,
    scenarioTag: epoch.scenarioTag || '',
    counts: epoch.counts || null,
    meta: epoch.meta || null
  };
}

function applyScenarioReportFromSync(response) {
  if (!response?.scenarioReport) {
    return false;
  }
  appState = appState || {};
  appState.scenarioReport = response.scenarioReport;
  if (response.cutoverReport) {
    appState.cutoverReport = response.cutoverReport;
  }
  if (response.scenarioCatalogPack?.scenarios?.length) {
    appState.scenarioCatalogPack = response.scenarioCatalogPack;
    rememberScenarioCatalog(response.scenarioCatalogPack);
  }
  lastRefreshFingerprint = '';
  return true;
}

/**
 * 页面/本地 epochs → 确保 SW catalog → bulk 重算场景，并用返回的 scenarioReport 立刻更新 UI。
 */
async function rebuildScenarioFromEpochs(epochs, { reason = '' } = {}) {
  if (tabId == null || !epochs?.length) {
    return false;
  }

  const slimEpochs = epochs.map(slimEpochForBackground).filter(Boolean);
  if (!slimEpochs.length) {
    return false;
  }

  if (ui.scenarioCatalog?.scenarios?.length && !appState?.scenarioCatalogPack?.scenarios?.length) {
    await safeRuntimeMessage({
      type: 'SS_APPLY_SCENARIO_CATALOG',
      tabId,
      catalog: ui.scenarioCatalog
    });
  }

  try {
    const response = await safeRuntimeMessage({
      type: 'SS_BULK_SYNC',
      tabId,
      runtime: ui.pageSettings?.pageSync?.runtime || ui.pageSettings?.pageSyncSummary?.runtime || null,
      epochs: slimEpochs
    });
    if (!response?.ok) {
      ui.panelSyncMessage = response?.error || 'Background 同步失败';
      return false;
    }
    applyScenarioReportFromSync(response);
    lastScenarioFromEpochsKey = buildScenarioFromEpochsKey(epochs);
    if (reason) {
      ui.panelSyncMessage = reason;
    }
    return true;
  } catch (error) {
    ui.panelSyncMessage = `场景累计同步失败：${error.message}`;
    return false;
  }
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

  const latestChanged = !epochIdsEqual(latestId, lastFollowedLatestEpochId);

  if (!ui.epochFollowLatest && ui.selectedEpochId != null) {
    if (latestChanged) {
      lastFollowedLatestEpochId = latestId;
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

  lastFollowedLatestEpochId = latestId;
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

async function restoreScenarioCatalogToPageIfNeeded() {
  const pack = appState?.scenarioCatalogPack || ui.scenarioCatalog;
  if (!pack?.scenarios?.length || tabId == null) {
    return false;
  }
  // 显式带 boName：无参 summary 在 runtime 未就绪时恒为 null，会每轮误灌 catalog 卡死 refresh
  const pageCheck = await evalInPage(`(function () {
    var ss = window.__StateScope__;
    if (!ss) return null;
    var bo = ${JSON.stringify(pack.boName || '')};
    if (ss.getScenarioCatalogSummary) {
      return ss.getScenarioCatalogSummary(bo || undefined) || ss.getScenarioCatalogSummary() || null;
    }
    var packOnPage = ss.getScenarioCatalogPack ? ss.getScenarioCatalogPack(bo || undefined) : null;
    return packOnPage && packOnPage.scenarios
      ? { scenarioCount: packOnPage.scenarios.length, catalogEpoch: packOnPage.catalogEpoch || '' }
      : null;
  })()`);
  if (
    pageCheck.ok &&
    pageCheck.result?.scenarioCount &&
    (!pack.catalogEpoch ||
      !pageCheck.result.catalogEpoch ||
      pageCheck.result.catalogEpoch === pack.catalogEpoch)
  ) {
    return false;
  }
  const pageApply = await applyScenarioCatalogToPage(pack);
  if (pageApply?.ok && pageApply.result?.ok !== false) {
    const sortedScenarios = [...pack.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const firstTag = sortedScenarios[0]?.tag;
    // 恢复 catalog 时保留用户已选的场景 tag，避免静默覆盖为 firstTag
    const existingTag = ui.scenarioTag || ui.pageSettings?.scenarioTag || '';
    const existingIsValid = existingTag && sortedScenarios.some((s) => s.tag === existingTag);
    const tagToSet = existingIsValid ? existingTag : firstTag;
    if (tagToSet) {
      await evalInPage(`window.__StateScope__?.setScenarioTag?.(${JSON.stringify(tagToSet)})`);
      ui.scenarioTag = tagToSet;
    }
    return true;
  }
  return false;
}

async function loadState() {
  if (tabId == null) {
    hydrateScenarioReportFromCatalog();
    return;
  }
  const prevCatalogPack = appState?.scenarioCatalogPack;
  try {
    const response = await safeRuntimeMessage({ type: 'SS_GET_STATE', tabId });
    if (response?.state) {
      appState = response.state;
      appState._bgEpochCount = appState.epochs?.length || 0;
      if (response.state.scenarioCatalogPack?.scenarios?.length) {
        rememberScenarioCatalog(response.state.scenarioCatalogPack);
      } else if (prevCatalogPack?.scenarios?.length) {
        // GET_STATE 偶发丢 pack 字段时保留本地面板上次已确认的 catalog
        appState.scenarioCatalogPack = prevCatalogPack;
      }
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
  await restoreScenarioCatalogToPageIfNeeded();
  if (!ui.selectedEpochId && appState.selectedEpochId) {
    ui.selectedEpochId = appState.selectedEpochId;
  }
}

function getCurrentEpochsForScenario() {
  const pageEpochs = ui.pageSettings?.pageSync?.epochs;
  if (Array.isArray(pageEpochs) && pageEpochs.length) {
    return pageEpochs;
  }
  return appState?.epochs || [];
}

function buildScenarioFromEpochsKey(epochs) {
  if (!epochs?.length) {
    return '';
  }
  const ignoreBefore = appState?.scenarioReport?.ignoreEpochsBefore || 0;
  let tagged = 0;
  for (const epoch of epochs) {
    if (!epoch?.scenarioTag) {
      continue;
    }
    if (ignoreBefore > 0 && (epoch.startedAt || 0) <= ignoreBefore) {
      continue;
    }
    tagged += 1;
  }
  return `${epochs.length}:${epochs[0]?.id ?? ''}:${tagged}:${ignoreBefore}`;
}

function pageEpochsNeedScenarioSync() {
  const epochs = getCurrentEpochsForScenario();
  if (!epochs.length) {
    return false;
  }
  const report = appState?.scenarioReport;
  if (!report?.scenarios || !Object.keys(report.scenarios).length) {
    return !!ui.scenarioCatalog?.scenarios?.length;
  }
  const ignoreBefore = report.ignoreEpochsBefore || 0;
  const tagCounts = {};
  for (const epoch of epochs) {
    const tag = epoch?.scenarioTag;
    if (!tag || !report.scenarios[tag]) {
      continue;
    }
    if (ignoreBefore > 0 && (epoch.startedAt || 0) <= ignoreBefore) {
      continue;
    }
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }
  return Object.entries(tagCounts).some(
    ([tag, count]) => (report.scenarios[tag]?.epochCount || 0) < count
  );
}

/**
 * 观察轮次已到位 → 用同一批 epochs 重算场景累计。
 */
async function syncScenarioFromEpochsIfNeeded() {
  if (tabId == null) {
    return false;
  }

  let epochs = getCurrentEpochsForScenario();
  const summaryCount = ui.pageSettings?.pageSyncEpochCount ?? 0;
  if ((!epochs.length || epochs.length < summaryCount) && summaryCount > 0) {
    await readPageSyncFull();
    epochs = getCurrentEpochsForScenario();
  }
  if (!epochs.length) {
    return false;
  }

  const key = buildScenarioFromEpochsKey(epochs);
  const scenarioLagging = pageEpochsNeedScenarioSync();
  if (key && key === lastScenarioFromEpochsKey && !scenarioLagging) {
    return false;
  }

  return rebuildScenarioFromEpochs(epochs, {
    reason: scenarioLagging ? '已按观察轮次重算场景累计' : ''
  });
}

async function syncFromPageIfNeeded() {
  if (tabId == null) {
    return false;
  }

  const page = ui.pageSettings || {};
  const pageEpochCount = getPageEpochCount();
  const bgEpochCount = appState?.epochs?.length || 0;
  const bgHasRuntime = !!appState?.runtime?.meta?.boName;
  const scenarioOutOfSync = pageEpochsNeedScenarioSync();

  const needsSync =
    page.stateScopeInstalled &&
    (page.relayBroken ||
      pageEpochCount > bgEpochCount ||
      (pageEpochCount > 0 && bgEpochCount === 0) ||
      (!bgHasRuntime && (page.pageSync?.runtime || page.pageMeta?.boName)) ||
      scenarioOutOfSync);

  if (!needsSync) {
    return syncScenarioFromEpochsIfNeeded();
  }

  if (!page.pageSync?.epochs?.length && pageEpochCount > 0) {
    await readPageSyncFull();
  }

  let epochs = ui.pageSettings?.pageSync?.epochs || [];
  if (!epochs.length) {
    epochs = getCurrentEpochsForScenario();
  }
  if (!epochs.length) {
    return syncScenarioFromEpochsIfNeeded();
  }

  return rebuildScenarioFromEpochs(epochs, {
    reason:
      bgEpochCount === 0 && pageEpochCount > 0
        ? `Background 已同步 ${pageEpochCount} 条摘要（展示用完整数据来自页面）`
        : scenarioOutOfSync
          ? '已按观察轮次重算场景累计'
          : ''
  });
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

/** 避免大 JSON 直接拼进 eval 导致 SyntaxError（Chrome 报 invalid） */
function evalJsonPayloadOnPage(data, handlerSource) {
  const payload = JSON.stringify(data);
  return evalInPage(
    `(function () {
      try {
        var config = JSON.parse(${JSON.stringify(payload)});
        ${handlerSource}
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    })()`
  );
}

function bindAllowlistUiFromEvalResult(evalResult, boName) {
  if (!evalResult?.ok || !evalResult.result?.ok) {
    return null;
  }
  const result = evalResult.result;
  ui.lastSyncedBoName = result.boName || boName || ui.lastSyncedBoName;
  const source = result.source || result.boot?.source || '';
  const sourceHint = result.sourceHint || result.boot?.sourceHint || '';
  ui.allowlistBinding = {
    boName: ui.lastSyncedBoName,
    version: result.version,
    fieldCount: result.fieldCount,
    active: result.active !== false,
    source,
    sourceHint
  };
  ui.pageSettings = {
    ...(ui.pageSettings || {}),
    allowlistActive: result.active !== false,
    allowlistBoName: ui.allowlistBinding.boName,
    allowlistVersion: ui.allowlistBinding.version,
    allowlistFieldCount: ui.allowlistBinding.fieldCount,
    allowlistSource: source,
    allowlistSourceHint: sourceHint
  };
  lastRefreshFingerprint = '';
  const sourcePart = formatAllowlistSourceLabel(source, sourceHint);
  ui.settingsMessage = result.active !== false ?
      `allowlist 已绑定：${result.boName} v${result.version || '—'}（${result.fieldCount || 0} 字段）${sourcePart}`
    : `allowlist 已写入但未激活，boName=${result.boName || '?'}`;
  return { ok: true, ...result };
}

function formatAllowlistSourceLabel(source, sourceHint) {
  if (!source) {
    return '';
  }
  if (source === 'window-registry') {
    return sourceHint
      ? ` · 来源 window-registry · ${sourceHint}`
      : ' · 来源 window-registry（领域自注册）';
  }
  if (source === 'webpack-source') {
    return sourceHint ? ` · 来源 webpack-source · ${sourceHint}` : ' · 来源 webpack-source';
  }
  return ` · 来源 ${source}`;
}

function getAllowlistHeaderSummary() {
  const ps = ui.pageSettings || {};
  const binding = ui.allowlistBinding || {};
  const boName = binding.boName || ps.allowlistBoName || '';
  const version = binding.version || ps.allowlistVersion || '';
  const fieldCount = binding.fieldCount ?? ps.allowlistFieldCount ?? 0;
  const active = ps.allowlistActive || binding.active;
  const source = binding.source || ps.allowlistSource || '';
  const sourceHint = binding.sourceHint || ps.allowlistSourceHint || '';
  if (active && boName) {
    return {
      active: true,
      text: `allowlist ${boName} v${version || '—'} · ${fieldCount} 字段${formatAllowlistSourceLabel(source, sourceHint)}`,
      short: `${boName} · ${fieldCount} 字段`
    };
  }
  if (ps.loadedAllowlistKeys?.length) {
    return {
      active: false,
      text: `allowlist 已加载 [${ps.loadedAllowlistKeys.join(', ')}]，当前 BO 未匹配`,
      short: '未匹配当前 BO'
    };
  }
  return {
    active: false,
    text: ps.stateScopeInstalled ? 'allowlist 未绑定（全量 Diff）' : 'allowlist 待 injector 挂载',
    short: '未绑定'
  };
}

function syncAllowlistUiFromPageSettings(ps, boName) {
  if (!ps?.allowlistActive || !ps.allowlistBoName) {
    return null;
  }
  const expectedBo = boName || ps.pageMeta?.boName || ps.allowlistBoName;
  if (expectedBo && ps.allowlistBoName !== expectedBo) {
    return null;
  }
  ui.lastSyncedBoName = ps.allowlistBoName;
  ui.allowlistBinding = {
    boName: ps.allowlistBoName,
    version: ps.allowlistVersion,
    fieldCount: ps.allowlistFieldCount,
    active: true,
    source: ps.allowlistSource || '',
    sourceHint: ps.allowlistSourceHint || ''
  };
  ui.pageSettings = {
    ...(ui.pageSettings || {}),
    allowlistActive: true,
    allowlistBoName: ps.allowlistBoName,
    allowlistVersion: ps.allowlistVersion,
    allowlistFieldCount: ps.allowlistFieldCount,
    allowlistSource: ps.allowlistSource || '',
    allowlistSourceHint: ps.allowlistSourceHint || ''
  };
  lastRefreshFingerprint = '';
  const sourcePart = formatAllowlistSourceLabel(ps.allowlistSource, ps.allowlistSourceHint);
  ui.settingsMessage = `allowlist 已绑定：${ps.allowlistBoName} v${ps.allowlistVersion || '—'}（${ps.allowlistFieldCount || 0} 字段）${sourcePart}`;
  return { ok: true, reason: 'page-active', boName: ps.allowlistBoName, source: ps.allowlistSource || 'page-read' };
}

async function syncAllowlistViaPageInjector(boName) {
  const evalResult = await evalInPage(`(function () {
    ${RESOLVE_STATE_SCOPE}
    var ss = __ssResolve();
    if (!ss || !ss.reloadAllowlist) {
      return { ok: false, error: 'injector 未就绪，请确认 bizDebug=true 并刷新单据页（或 Console 执行 top.__StateScope__）' };
    }
    var reload = ss.reloadAllowlist();
    var config = reload && reload.config;
    if (!config || !config.fields || !config.fields.length) {
      var expectedBo = ${JSON.stringify(boName || '')};
      var diag = ss.diagnoseAllowlistScan ? ss.diagnoseAllowlistScan(expectedBo || undefined) : null;
      var hint = expectedBo
        ? ('未从页面 webpack 找到与 ' + expectedBo + ' 匹配的 *.allowlist.ts，请到概览页导入领域白名单')
        : '未从页面 webpack 找到 *.allowlist.ts，请到概览页导入领域白名单';
      if (diag && !diag.requireCount) {
        hint += '（未捕获 __webpack_require__；Sources 的 webpack:// 仅是 source map）';
      }
      return {
        ok: false,
        error: hint,
        reason: (reload && reload.boot && reload.boot.source) || 'need-import',
        boot: reload && reload.boot,
        loadedKeys: reload && reload.loadedKeys,
        diagnose: diag,
        stateScopeVersion: ss.version || ''
      };
    }
    var expected = ${JSON.stringify(boName || '')};
    if (expected && config.boName !== expected) {
      return {
        ok: false,
        error: 'allowlist boName=' + config.boName + ' 与当前页 ' + expected + ' 不一致',
        boName: config.boName
      };
    }
    var srcMeta = (reload && reload.source) || (ss.getAllowlistSource ? ss.getAllowlistSource() : null) || {};
    var bootSource = (reload && reload.boot && reload.boot.source) || '';
    return {
      ok: true,
      active: true,
      version: config.version || '',
      fieldCount: config.fields.length,
      boName: config.boName,
      source: srcMeta.source || bootSource || 'bundled',
      sourceHint: srcMeta.sourceHint || reload && reload.boot && reload.boot.sourceHint || ''
    };
  })()`);
  if (!evalResult.ok) {
    return { ok: false, error: evalResult.error || '页面 eval 失败' };
  }
  if (!evalResult.result?.ok) {
    return evalResult.result || { ok: false, error: 'injector reloadAllowlist 失败' };
  }
  return bindAllowlistUiFromEvalResult(evalResult, boName);
}

async function readPageSettings(options = {}) {
  const includeAllowlistFields = options.includeAllowlistFields === true;
  const allowlistFieldsExpr = includeAllowlistFields ?
      `(cfg && cfg.fields ? cfg.fields : []).map(function (f) {
      return { path: f.path, stateType: f.stateType, configKey: f.configKey, oldEntry: f.oldEntry };
    })`
    : '[]';

  const response = await evalInPage(`(function () {
    ${RESOLVE_STATE_SCOPE}
    var ss = __ssResolve();
    var cfg = ss && ss.getAllowlistConfig ? ss.getAllowlistConfig() : null;
    var srcMeta = ss && ss.getAllowlistSource ? ss.getAllowlistSource() : null;
    var allowlistFields = ${allowlistFieldsExpr};
    return {
      bizDebug: localStorage.getItem('bizDebug') === 'true',
      stateScopeVerbose: localStorage.getItem('stateScopeVerbose') === 'true',
      stateScopeDebug: localStorage.getItem('stateScopeDebug') === 'true',
      stateScopeAutoAllowlist: localStorage.getItem('stateScopeAutoAllowlist') !== 'false',
      stateScopeProfile: (ss && ss.getProfileMode ? ss.getProfileMode() : null) || localStorage.getItem('stateScopeProfile') || 'auto',
      profileDetection: (ss && ss.getProfileDetection ? ss.getProfileDetection() : null) || null,
      stateScopeInstalled: !!(ss && ss.version),
      stateScopeHooksReady: !!(ss && ss.installed),
      stateScopeVersion: (ss && ss.version) || '',
      allowlistActive: !!(cfg && cfg.fields && cfg.fields.length),
      allowlistFieldCount: (cfg && cfg.fields && cfg.fields.length) || 0,
      allowlistVersion: (cfg && cfg.version) || '',
      allowlistBoName: (cfg && cfg.boName) || '',
      allowlistNote: (cfg && cfg.note) || '',
      allowlistSource: (srcMeta && srcMeta.source) || '',
      allowlistSourceHint: (srcMeta && srcMeta.sourceHint) || '',
      allowlistFields: allowlistFields,
      loadedAllowlistKeys: (ss && ss.listLoadedAllowlists ? ss.listLoadedAllowlists() : []) || [],
      pageMeta: (ss && ss.getMeta ? ss.getMeta() : null) || null,
      pageSyncSummary: (ss && ss.getPanelSyncSummary ? ss.getPanelSyncSummary() : null) || null,
      scenarioTag: (ss && ss.getScenarioTag ? ss.getScenarioTag() : null) || '',
      scenarioCatalogSummary: (ss && ss.getScenarioCatalogSummary ? ss.getScenarioCatalogSummary() : null) || null,
      relayBroken: ss && ss.extensionRelayBroken === true,
      relayError: (ss && ss.extensionRelayError) || ''
    };
  })()`);
  if (response.ok) {
    ui.pageSettings = response.result;
    ui.pageSettings.pageSyncEpochCount = ui.pageSettings.pageSyncSummary?.epochCount || 0;
    const pageBo = ui.pageSettings.pageMeta?.boName || ui.pageSettings.allowlistBoName || '';
    const tag = ui.pageSettings.scenarioTag || '';
    if (pageBo === 'OutsourceStockin' && tag.startsWith('oi-')) {
      ui.pageSettings.scenarioTagMismatch = `当前页 ${pageBo} 但 scenarioTag=${tag}（委外发料残留）`;
    } else if (pageBo === 'OutsourceIssue' && tag.startsWith('os-')) {
      ui.pageSettings.scenarioTagMismatch = `当前页 ${pageBo} 但 scenarioTag=${tag}（委外入库残留）`;
    } else {
      ui.pageSettings.scenarioTagMismatch = '';
    }
    if (ui.pageSettings.allowlistActive) {
      syncAllowlistUiFromPageSettings(ui.pageSettings, pageBo);
    }
  }
  return response;
}

async function readPageSyncFull() {
  const response = await evalInPage(`window.__StateScope__?.getPanelSyncPayload?.() || null`);
  if (response.ok && response.result) {
    lastFullPageSyncAt = Date.now();
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
    lastPayloadSyncedLatestEpochId = ui.pageSettings.pageSyncSummary?.latestEpochId ?? null;
    applyPageSyncToAppState();
    return response.result;
  }
  return null;
}

function getPageEpochCount() {
  const cached = ui.pageSettings?.pageSync?.epochs?.length ?? 0;
  const summary = ui.pageSettings?.pageSyncEpochCount ?? 0;
  return Math.max(cached, summary);
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
  const source = binding.source || ps.allowlistSource || '';
  const sourceHint = binding.sourceHint || ps.allowlistSourceHint || '';

  if (boName || active) {
    const fieldPart = fieldCount ? `${fieldCount} 字段 · ` : '';
    const sourcePart = source ?
        source === 'webpack-source' ?
          sourceHint ?
            `webpack-source · ${sourceHint} · `
          : 'webpack-source · '
        : `${source} · `
      : '';
    return `${boName || '—'} · ${sourcePart}字段清单 v${version || '—'} · ${fieldPart}升级后 ${report?.hasNewChainObserved ? '已观测' : '影子未写入'}`;
  }
  return '字段清单未绑定';
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
      headline: '尚无字段清单累计数据',
      subline: '加载字段清单并操作单据字段后自动累计'
    };
  }
  if (!report.hasNewChainObserved) {
    return {
      status: 'warn',
      headline: SHADOW_STORE_MISSING.headline,
      subline: SHADOW_STORE_MISSING.subline
    };
  }
  const blocked = report.summary?.blockedFields || 0;
  const ready = report.summary?.readyFields || 0;
  const total = report.summary?.totalFields || 0;
  if (blocked > 0) {
    return {
      status: 'error',
      headline: `阻塞 · ${blocked} 个字段存在升级前后不一致`,
      subline: `就绪 ${ready}/${total} · 累计 ${total} 个字段`
    };
  }
  if (ready === total && total > 0) {
    return {
      status: 'ok',
      headline: `通过 · ${ready}/${total} 字段可切流`,
      subline: '当前会话字段清单均无升级前后不一致'
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

  await readPageSettings({ includeAllowlistFields: needsAllowlistCatalogFields() });
  const boName = await resolveBoNameForAllowlist();
  // 切单后 pageMeta.boName 变了：强制按当前 BO 重绑 UI（避免 lastSynced 残留上一单）
  if (
    boName &&
    ui.lastSyncedBoName &&
    boName !== ui.lastSyncedBoName
  ) {
    ui.lastSyncedBoName = '';
  }
  const fromPage = syncAllowlistUiFromPageSettings(ui.pageSettings, boName);
  if (fromPage?.ok) {
    return fromPage;
  }

  // 页面 injector 已绑定（bundled / bridge），无需 Panel 再 fetch
  if (!force && ui.pageSettings?.allowlistActive && ui.pageSettings?.allowlistBoName === boName) {
    return { ok: true, reason: 'page-active' };
  }

  if (!force && boName && boName === ui.lastSyncedBoName && ui.pageSettings?.allowlistActive) {
    return { ok: true, reason: 'already-synced' };
  }

  const injected = await syncAllowlistViaPageInjector(boName);
  if (injected?.ok) {
    return injected;
  }

  // 扩展不再打包 allowlists/*.json；未命中 webpack → 引导概览页导入
  const tip =
    injected?.error ||
    (boName ?
      `未从页面 webpack 找到与 ${boName} 匹配的 *.allowlist.ts，请到概览页导入领域白名单`
    : '未从页面 webpack 找到 *.allowlist.ts，请到概览页导入领域白名单');
  if (force) {
    ui.settingsMessage = tip;
  }
  return { ok: false, reason: 'need-import', error: tip };
}

async function applyScenarioCatalogToPage(catalog) {
  const evalResult = await evalJsonPayloadOnPage(
    catalog,
    `${RESOLVE_STATE_SCOPE}
    var ss = __ssResolve();
    if (!ss || !ss.applyScenarioCatalog) {
      return { ok: false, error: 'injector 未就绪或未升级' };
    }
    var applied = ss.applyScenarioCatalog(config);
    var summary = ss.getScenarioCatalogSummary ? ss.getScenarioCatalogSummary() : null;
    try {
      document.documentElement.setAttribute('data-state-scope-scenario-catalog', JSON.stringify(config));
    } catch (e) {}
    window.postMessage({ channel: 'StateScopeScenarioCatalog', config: config }, window.location.origin);
    return { ok: applied, summary: summary, error: applied ? '' : '场景包写入页面失败（normalize 或 localStorage）' };`
  );
  return evalResult;
}

async function applyScenarioCatalogBundle(catalog) {
  if (tabId == null) {
    return { ok: false, error: 'DevTools 未绑定单据 Tab，请从单据页打开 StateScope Panel' };
  }

  const pageBo =
    ui.pageSettings?.pageMeta?.boName ||
    ui.pageSettings?.allowlistBoName ||
    appState?.runtime?.meta?.boName ||
    '';
  if (catalog?.boName && pageBo && catalog.boName !== pageBo) {
    return {
      ok: false,
      error: `场景包 boName=${catalog.boName} 与当前页 ${pageBo} 不一致，请打开对应单据页再导入`
    };
  }

  const swResponse = await safeRuntimeMessage({
    type: 'SS_APPLY_SCENARIO_CATALOG',
    tabId,
    catalog
  });
  if (!swResponse?.ok) {
    return (
      swResponse || {
        ok: false,
        error: '后台应用失败（请重载扩展或刷新单据页后再试）'
      }
    );
  }

  const normalized = swResponse.catalog || catalog;
  rememberScenarioCatalog(normalized);
  // lastSyncedScenarioCatalogKey 已在 rememberScenarioCatalog 用指纹写入
  if (swResponse.scenarioReport) {
    appState.scenarioReport = swResponse.scenarioReport;
    hydrateScenarioReportFromCatalog();
  }

  const pageApply = await applyScenarioCatalogToPage(normalized);
  if (!pageApply?.ok || pageApply.result?.ok === false) {
    return {
      ok: false,
      error:
        pageApply?.result?.error ||
        pageApply?.error ||
        'injector 未就绪：请先 localStorage.bizDebug=true 并刷新单据页'
    };
  }

  // 回灌 catalog 时保留用户已选场景，禁止每次都重置为 firstTag（会导致 S03 操作全记到 S01）
  const sortedScenarios = [...(normalized.scenarios || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const firstTag = sortedScenarios[0]?.tag;
  const existingTag = ui.scenarioTag || ui.pageSettings?.scenarioTag || ui.selectedScenarioTag || '';
  const existingIsValid = existingTag && sortedScenarios.some((s) => s.tag === existingTag);
  const tagToSet = existingIsValid ? existingTag : firstTag;
  if (tagToSet) {
    await evalInPage(`window.__StateScope__?.setScenarioTag?.(${JSON.stringify(tagToSet)})`);
    ui.scenarioTag = tagToSet;
    if (!ui.selectedScenarioTag || !sortedScenarios.some((s) => s.tag === ui.selectedScenarioTag)) {
      ui.selectedScenarioTag = tagToSet;
    }
  }

  // 本地立刻挂上 pack，避免下一轮 refresh 误判 SW missing 而反复 re-upload
  appState = appState || {};
  appState.scenarioCatalogPack = normalized;

  await loadState();
  // loadState 若因序列化未带回 pack，保留本地挂载
  if (!appState.scenarioCatalogPack?.scenarios?.length) {
    appState.scenarioCatalogPack = normalized;
  }
  return swResponse;
}

async function recoverScenarioCatalogForBo(boName) {
  // 优先页面领域自注册 / injector pack，避免 ui.scenarioCatalog 旧上传压过 SSOT
  let catalog = null;
  const fromPage = await pullScenarioCatalogFromPage(boName);
  if (fromPage?.pack?.scenarios?.length) {
    catalog = fromPage.pack;
  }
  if (!catalog && ui.scenarioCatalog?.scenarios?.length && ui.scenarioCatalog.boName === boName) {
    catalog = ui.scenarioCatalog;
  }
  if (!catalog) {
    return null;
  }
  const swResponse = await safeRuntimeMessage({
    type: 'SS_APPLY_SCENARIO_CATALOG',
    tabId,
    catalog
  });
  if (!swResponse?.ok) {
    return null;
  }
  rememberScenarioCatalog(swResponse.catalog || catalog);
  if (swResponse.scenarioReport) {
    appState = appState || {};
    appState.scenarioReport = swResponse.scenarioReport;
    hydrateScenarioReportFromCatalog();
  }
  appState = appState || {};
  appState.scenarioCatalogPack = swResponse.catalog || catalog;
  ui.lastSyncedScenarioCatalogKey = catalogSyncKey(swResponse.catalog || catalog);
  await loadState();
  if (!appState.scenarioCatalogPack?.scenarios?.length) {
    appState.scenarioCatalogPack = swResponse.catalog || catalog;
  }
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

  // 领域自注册优先：catalogEpoch+source 对账；① 出现只在 source 未升到 window-registry 时强制推一次
  if (boName) {
    const fromPage = await pullScenarioCatalogFromPage(boName);
    if (fromPage?.pack?.scenarios?.length) {
      const pageKey = catalogSyncKey(fromPage.pack);
      const uiKey = catalogSyncKey(ui.scenarioCatalog);
      const swKey = catalogSyncKey(appState?.scenarioCatalogPack);
      const forceAuthority =
        fromPage.pack.source === 'window-registry' &&
        appState?.scenarioCatalogPack?.source !== 'window-registry';
      if (force || forceAuthority || pageKey !== uiKey || pageKey !== swKey || pageKey !== ui.lastSyncedScenarioCatalogKey) {
        return applyScenarioCatalogBundle(fromPage.pack);
      }
      return {
        ok: true,
        reason: 'page-registry-synced',
        boName,
        version: fromPage.pack.version,
        catalogEpoch: fromPage.pack.catalogEpoch,
        source: fromPage.source
      };
    }
  }

  const expectedKey = catalogSyncKey(
    appState?.scenarioCatalogPack || ui.scenarioCatalog || null
  );

  // 仅当 SW 侧也确有 catalog 时才跳过；否则 Panel hydrate 出的就绪报告会掩盖「SW 丢包」
  const swHasCatalog = !!appState?.scenarioCatalogPack?.scenarios?.length;
  const syncedKeyMatches =
    !!ui.lastSyncedScenarioCatalogKey && ui.lastSyncedScenarioCatalogKey === expectedKey;
  if (
    !force &&
    boName &&
    report?.boName === boName &&
    isL3ScenarioReady(report) &&
    (swHasCatalog || syncedKeyMatches)
  ) {
    ui.lastSyncedScenarioCatalogKey = expectedKey || ui.lastSyncedScenarioCatalogKey;
    return { ok: true, reason: 'already-synced', boName: report.boName, version: report.catalogVersion };
  }

  if (
    !force &&
    boName &&
    report?.boName === boName &&
    isL3ScenarioReady(report) &&
    !swHasCatalog &&
    !syncedKeyMatches &&
    ui.scenarioCatalog?.scenarios?.length
  ) {
    return applyScenarioCatalogBundle(ui.scenarioCatalog);
  }

  if (!boName) {
    return { ok: false, reason: 'no-boName', error: '未识别 boName，无法加载场景 checklist' };
  }

  const bootstrapForce = force || report?.boName !== boName;
  try {
    const bootstrap = await chrome.runtime.sendMessage({
      type: 'SS_BOOTSTRAP_SCENARIO_CATALOG',
      tabId,
      boName,
      force: bootstrapForce
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
      ui.lastSyncedScenarioCatalogKey = catalogSyncKey(bootstrap.catalog || ui.scenarioCatalog);
      await loadState();
      return bootstrap;
    }
    if (bootstrap?.needsUpload) {
      const recovered = await recoverScenarioCatalogForBo(boName);
      if (recovered) {
        return recovered;
      }
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

async function importAllowlistTsFile(file) {
  if (!file) {
    return { ok: false, error: '未选择文件' };
  }
  const name = String(file.name || '');
  if (!/\.ts$/i.test(name)) {
    return { ok: false, error: '请选择 .allowlist.ts 文件' };
  }
  const parseApi = window.StateScopeParseAllowlistTs;
  if (!parseApi?.parseAllowlistTsSource) {
    return { ok: false, error: '解析器未加载' };
  }
  let text;
  try {
    text = await file.text();
  } catch (error) {
    return { ok: false, error: error?.message || '读取文件失败' };
  }
  const parsed = parseApi.parseAllowlistTsSource(text);
  if (!parsed.ok) {
    return parsed;
  }
  const pageBo = await resolveBoNameForAllowlist();
  if (pageBo && parsed.config.boName && parsed.config.boName !== pageBo) {
    return {
      ok: false,
      error: `文件 boName=${parsed.config.boName} 与当前页 ${pageBo} 不一致`
    };
  }
  const evalResult = await evalJsonPayloadOnPage(
    parsed.config,
    `${RESOLVE_STATE_SCOPE}
    var ss = __ssResolve();
    if (!ss || !ss.applyAllowlistConfig) {
      return { ok: false, error: 'injector 未就绪' };
    }
    var applied = ss.applyAllowlistConfig(config, {
      source: 'settings-import',
      sourceHint: ${JSON.stringify(name)}
    });
    var activeCfg = ss.getAllowlistConfig ? ss.getAllowlistConfig() : null;
    var srcMeta = ss.getAllowlistSource ? ss.getAllowlistSource() : null;
    return {
      ok: applied,
      active: !!(activeCfg && activeCfg.fields && activeCfg.fields.length),
      version: config.version || '',
      fieldCount: (config.fields && config.fields.length) || 0,
      boName: config.boName,
      source: (srcMeta && srcMeta.source) || 'settings-import',
      sourceHint: (srcMeta && srcMeta.sourceHint) || ${JSON.stringify(name)}
    };`
  );
  const bound = bindAllowlistUiFromEvalResult(evalResult, pageBo);
  if (bound?.ok) {
    showToast(ui.settingsMessage || 'allowlist 已导入');
    return bound;
  }
  return {
    ok: false,
    error: evalResult.result?.error || evalResult.error || '导入失败'
  };
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
    return `<div class="empty">尚无字段清单累计。请确认领域 *.allowlist.ts 已从页面 webpack 加载（或在概览页导入），并操作单据触发观测轮次。</div>`;
  }

  return `<div class="cutover-table-wrap">
    <table class="cutover-table">
      <thead>
        <tr>
          <th>字段</th>
          <th>累计轮次</th>
          <th>升级前后不一致</th>
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
              <td><span class="chip">${esc(severityZh(item.lastSeverity))}</span></td>
              <td>${item.cutoverReady ? '<span class="chip on">可切流</span>' : `<span class="chip off">${esc(item.blockReason || '阻塞')}</span>`}</td>
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
    <div class="banner info">切流报告按字段清单跨观测轮次累计「升级前后不一致」；开发向观测/对比监测保持不变。</div>
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
    applyScenarioMarkLocally,
    clearScenarioFromEpochsKey: () => {
      lastScenarioFromEpochsKey = '';
    }
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
    const allow = getAllowlistHeaderSummary();
    headerMeta.innerHTML = `
      <div class="header-meta-stack">
        <div class="header-meta-row">
          <span>单据 <strong>${esc(meta.boName || '(unknown)')}</strong></span>
          <span class="sep">|</span>
          <span>Profile <strong title="${profileTitle}">${esc(profile)}</strong>${conf}</span>
          <span class="sep">|</span>
          <span>old <span class="${oldOk ? 'chain-ok' : 'chain-off'}">${oldOk ? '✓' : '✗'}</span></span>
          <span>${profile === 'lowcode' ? 'shadow' : 'new'} <span class="${newOk ? 'chain-ok' : 'chain-off'}">${newOk ? '✓' : '✗'}</span></span>
        </div>
        <div class="header-meta-row header-allowlist ${allow.active ? 'is-active' : 'is-idle'}" title="${esc(allow.text)}">
          <span class="header-allowlist-label">Allowlist</span>
          <span class="header-allowlist-text">${esc(allow.text)}</span>
        </div>
      </div>
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
      <div class="footer-line">页面缓存 ${pageEpochCount} 条观测 · Background ${appState?._bgEpochCount ?? '—'} 条</div>
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
    return { status: 'idle', headline: ZH.waitEpoch || '等待观测轮次', subline: '操作单据字段后自动更新' };
  }
  const mismatch = epoch.diffSummary?.logicMismatch || 0;
  const changed = epoch.counts?.changedSample || 0;
  if (mismatch > 0) {
    return { status: 'error', headline: `发现 ${mismatch} 个升级前后不一致`, subline: '升级前与升级后状态不一致' };
  }
  if (epoch.hasNewChain) {
    return { status: 'ok', headline: '本次无升级前后冲突', subline: `${changed} 个变更字段（含未升级项）` };
  }
  if (changed > 0) {
    return {
      status: 'warn',
      headline: SHADOW_STORE_MISSING.headline,
      subline: `${changed} 个变更 · ${SHADOW_STORE_MISSING.subline}`
    };
  }
  return { status: 'idle', headline: '本次无字段变更', subline: '观测轮次已记录' };
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
    <div class="stat stat-accent"><div class="stat-label">升级前后不一致</div><div class="stat-value">${impact.mismatch}</div></div>
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
      <div class="subtle">当前观测轮次无升级前后不一致；待接入项可在「升级前后对比」查看升级前预览。</div>
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
    lines.push(`页面已有 ${pageCache} 条观测轮次但未进 Panel → 点左下角「重新同步 Panel」。`);
  } else if (profile === 'lowcode') {
    lines.push('当前为低代码取证线：升级前（用户所见）vs 升级后（影子状态）。');
    lines.push('请确认：① stateScopeProfile=lowcode（或 auto 且 boName 已映射）② 扩展重载后 F5 单据页。');
    lines.push('hook 就绪后改表头字段或触发 doDispatch，应出现观测轮次；勿用销货单 refreshView 口径。');
    if (!diag.lowcodeViewModel) {
      lines.push('未检测到 MDF viewModel → 等页面渲染完后点「重新挂 Hook」，或 F5。');
    }
  } else {
    lines.push('当前为传统单据取证线：StateCollector / FormController.refreshView vs statePatches。');
    lines.push('init-full 发生在 hook 安装之前时会丢失（刷新后常见）。');
    lines.push('请确认：① 升级开关 ON  ② 先设场景  ③ 再刷新/重新进入新增页。');
    lines.push('或 hook 就绪后改任意表头字段，应至少出现 1 条观测轮次。');
    if (!diag.stateManager) {
      lines.push('当前未检测到 stateManager → 升级开关可能未开，或 ServicePlus 未加载。');
    }
  }

  return `<div class="empty timeline-empty-hint">
    <div>${ZH.noEpoch || '尚无观测轮次'}</div>
    <ul>${lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
    <div class="subtle">Console 搜 <code>[StateScope] Epoch</code>；页眉链状态 ✓ 只表示 hook 目标已找到，不代表已有观测轮次。</div>
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
        mismatch > 0 ? `${mismatch} 升级前后不一致`
        : changed > 0 ? `${changed} 字段变化`
        : '无变化';
      const active = epochIdsEqual(getSelectedEpoch()?.id, epoch.id) ? ' active' : '';

      return `<button type="button" class="tl-item${active}" data-select-epoch="${epoch.id}">
        <div class="tl-time">${esc(epoch.timeLabel || '—')}</div>
        <div class="tl-card">
          <div class="tl-title">${esc(epochLabel(epoch.id))} · ${esc(epoch.trigger)}</div>
          <div class="tl-meta">
            <span class="dot ${timelineStatusDot(status)}"></span>
            <span>${esc(label)}${esc(deltaHint)}</span>
            <span class="tl-tag">${changed}/${epoch.counts?.finalSnap || 0}</span>
            <span class="tl-tag">${epoch.phase === 'incremental' ? 'incr' : epoch.phase || 'incr'}</span>
            ${epoch.scenarioTag ? `<span class="tl-tag">${esc(epoch.scenarioTag)}</span>` : ''}
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
      return `${ZH.noEpoch || '尚无观测轮次'}，请操作字段触发 doDispatch（低代码线，非 refreshView）。`;
    }
    return `${ZH.noEpoch || '尚无观测轮次'}，请操作单据字段触发 refreshView（传统线）。`;
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
    <span class="badge badge-ok">${s.ok || 0} ${DIFF_COUNTER_ZH.ok}</span>
    <span class="badge badge-bad">${s.logicMismatch || 0} ${DIFF_COUNTER_ZH.logicMismatch}</span>
    <span class="badge badge-warn">${s.legacyOnly || 0} ${DIFF_COUNTER_ZH.legacyOnly}</span>
    <span class="badge badge-muted">${s.pending || 0} ${DIFF_COUNTER_ZH.pending}</span>
  </div>`;
}

function renderDiffCounters(summary) {
  const s = summary || {};
  return `<div class="diff-counter-grid">
    <div class="diff-counter ok"><div class="num">${s.ok || 0}</div><div class="label">${DIFF_COUNTER_ZH.ok}</div></div>
    <div class="diff-counter bad"><div class="num">${s.logicMismatch || 0}</div><div class="label">${DIFF_COUNTER_ZH.logicMismatch}</div></div>
    <div class="diff-counter warn"><div class="num">${s.legacyOnly || 0}</div><div class="label">${DIFF_COUNTER_ZH.legacyOnly}</div></div>
    <div class="diff-counter"><div class="num">${s.pending || 0}</div><div class="label">${DIFF_COUNTER_ZH.pending}</div></div>
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

function isAllowlistBindingNoise(message) {
  if (!message) {
    return false;
  }
  return (
    /allowlist (已绑定|已导入|已写入|已清除|已取消)/.test(message) ||
    /Diff 恢复全量/.test(message) ||
    /自动加载 allowlist/.test(message)
  );
}

function renderOverviewToolbar() {
  const filters = CONSOLE_FILTER_PRESETS.map(
    (item) =>
      `<button type="button" class="btn-mini" id="${item.id}" title="复制 Console 过滤词：${esc(item.filter)}">${esc(item.label)}</button>`
  ).join('');

  return `<div class="overview-toolbar">
    <span class="overview-toolbar-label">Console</span>
    ${filters}
    <span class="overview-toolbar-sep"></span>
    <button type="button" class="btn-mini" id="action-copy-diagnose" title="复制 diagnoseLastEpoch">diagnoseLastEpoch</button>
    <button type="button" class="btn-mini" id="action-export-snapshot" title="导出当前观测轮次 JSON">导出观测 JSON</button>
    <button type="button" class="btn-mini" data-goto-tab="timeline">观测时间线</button>
    <button type="button" class="btn-mini" data-goto-tab="diff">升级对比</button>
    <button type="button" class="btn-mini btn-warn" id="action-clear-cache" title="清除页面与 Background 观测缓存">清除缓存</button>
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
        `选择「${ZH.epochTimeline || '观测时间线'}」中的条目查看详情（低代码：升级前用户所见 vs 升级后影子）`
      : `选择「${ZH.epochTimeline || '观测时间线'}」中的条目查看详情（传统：StateCollector vs statePatches）`;
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
        <div class="detail-title">${esc(epochLabel(epoch.id))} 详情</div>
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
      <div class="card-head">对比摘要（字段清单）</div>
      ${renderDiffCounters(epoch.diffSummary)}
      <button type="button" class="btn-link" data-goto-tab="diff">打开升级前后对比 →</button>
    </div>
  </div>`;
}

function renderTimelinePage() {
  const epochs = appState?.epochs || [];
  const epoch = getSelectedEpoch();

  return `<div class="timeline-page">
    <div class="card">
      <div class="card-head">${ZH.epochTimeline || '观测时间线'}</div>
      ${renderTimelineList(epochs)}
    </div>
    <div class="card">${renderEpochDetailColumn(epoch, { showVerdict: true })}</div>
  </div>`;
}

function renderDiffTab() {
  const epoch = getSelectedEpoch();
  if (!epoch) {
    return `<div class="empty">${ZH.noEpoch || '尚无观测轮次'}，或请先选择时间线条目。</div>`;
  }

  return `<div class="diff-page">
    <div class="card">
      <div class="card-head">升级前后对比 · ${esc(epochLabel(epoch.id))}</div>
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
  const scenarioReport = appState?.scenarioReport;
  const scenarioEpochSum = Object.values(scenarioReport?.scenarios || {}).reduce(
    (sum, item) => sum + (item?.epochCount || 0),
    0
  );
  const scenarioReadySum = Object.values(scenarioReport?.scenarios || {}).reduce(
    (sum, item) => sum + (item?.readyFields || 0),
    0
  );
  // 内容身份指纹：禁止纳入 updatedAt 等时间戳，否则每轮 loadState 都会整页重绘
  return [
    ui.tab,
    ui.selectedEpochId ?? '',
    ui.scenarioTag ?? '',
    ui.selectedScenarioTag ?? '',
    appState?.epochs?.length ?? 0,
    appState?.epochs?.[0]?.id ?? '',
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
    epoch?.id ?? '',
    epoch?.scenarioTag ?? '',
    epoch?.diffSummary?.logicMismatch ?? '',
    report?.summary?.blockedFields ?? '',
    (appState?.issues || []).length,
    scenarioReport?.catalogVersion ?? '',
    scenarioReport?.catalogEpoch ?? '',
    Object.keys(scenarioReport?.scenarios || {}).length,
    scenarioReport?.summary?.markedComplete ?? 0,
    scenarioReport?.summary?.pass ?? 0,
    scenarioReport?.summary?.inProgress ?? 0,
    scenarioReport?.summary?.notStarted ?? 0,
    scenarioReport?.summary?.block ?? 0,
    scenarioEpochSum,
    scenarioReadySum,
    ui.scenarioCatalog?.version ?? '',
    ui.scenarioCatalog?.catalogEpoch ?? '',
    JSON.stringify(ui.expanded)
  ].join('|');
}

function hasLiveTextSelectionInPanel() {
  try {
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed) {
      return false;
    }
    const text = String(sel.toString() || '');
    if (!text.trim()) {
      return false;
    }
    const root = document.getElementById('app');
    if (!root) {
      return false;
    }
    return root.contains(sel.anchorNode) || root.contains(sel.focusNode);
  } catch {
    return false;
  }
}

function capturePanelScrollState() {
  const main = document.querySelector('.main');
  if (!main) {
    return null;
  }
  const nested = [];
  main.querySelectorAll('*').forEach((el) => {
    if (el.scrollHeight > el.clientHeight + 8) {
      const style = window.getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(style.overflow)) {
        nested.push({
          key: `${el.className}|${el.id}|${el.tagName}`,
          top: el.scrollTop,
          left: el.scrollLeft
        });
      }
    }
  });
  return { mainTop: main.scrollTop, mainLeft: main.scrollLeft, nested };
}

function restorePanelScrollState(state) {
  if (!state) {
    return;
  }
  const main = document.querySelector('.main');
  if (!main) {
    return;
  }
  main.scrollTop = state.mainTop || 0;
  main.scrollLeft = state.mainLeft || 0;
  if (!state.nested?.length) {
    return;
  }
  const used = new Set();
  main.querySelectorAll('*').forEach((el) => {
    if (el.scrollHeight <= el.clientHeight + 8) {
      return;
    }
    const style = window.getComputedStyle(el);
    if (!/(auto|scroll)/.test(style.overflowY) && !/(auto|scroll)/.test(style.overflow)) {
      return;
    }
    const key = `${el.className}|${el.id}|${el.tagName}`;
    const hit = state.nested.find((item, index) => item.key === key && !used.has(index));
    if (!hit) {
      return;
    }
    const idx = state.nested.indexOf(hit);
    used.add(idx);
    el.scrollTop = hit.top || 0;
    el.scrollLeft = hit.left || 0;
  });
}

/** 整页重绘（保留滚动；划选中则推迟） */
function renderMainPanelPreservingView({ allowDuringSelection = false } = {}) {
  if (!allowDuringSelection && hasLiveTextSelectionInPanel()) {
    deferredPanelRedraw = true;
    return false;
  }
  const scroll = capturePanelScrollState();
  renderMainPanel();
  restorePanelScrollState(scroll);
  deferredPanelRedraw = false;
  return true;
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
  renderMainPanelPreservingView({ allowDuringSelection: true });
}

async function clearStateScopeCache() {
  if (
    !window.confirm('清除当前 Tab 的 StateScope 观测缓存？\n不会删除 Jira/Issue、allowlist 绑定与场景包。')
  ) {
    return;
  }

  await safeRuntimeMessage({ type: 'SS_CLEAR_CACHE', tabId });
  await evalInPage(`(function () {
    var ss = window.__StateScope__;
    if (ss && ss.clearPanelCache) return ss.clearPanelCache();
    return { ok: false, error: 'injector 未就绪' };
  })()`);

  ui.selectedEpochId = null;
  ui.epochFollowLatest = true;
  if (appState) {
    appState.epochs = [];
    appState.selectedEpochId = null;
    appState.cutoverReport = null;
    appState.scenarioReport = null;
  }

  await refresh({ force: true, reason: 'user' });
  showToast('StateScope 缓存已清除');
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
      `<div class="banner warn">${esc(SHADOW_STORE_MISSING.bannerLowcode)}</div>`
    : `<div class="banner warn">${esc(SHADOW_STORE_MISSING.bannerTraditional)}</div>`;
  const groups = epoch.diffGroups || { main: [], details: [] };
  const mainRows = filterDiffRows(groups.main, epoch.hasNewChain);
  const focusPath = ui.diffFocusPath;

  const renderRows = (rows) => {
    if (!rows.length) {
      return '<div class="empty">无匹配对比项</div>';
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
          <span class="chip">${esc(severityZh(row.resultLabel || row.severity))}</span>
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
      <label><input type="checkbox" id="diff-only-mismatch" ${ui.diffOnlyMismatch ? 'checked' : ''} /> 仅看升级前后不一致</label>
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

function getOverviewNoticeBanner() {
  const msg = ui.settingsMessage;
  if (!msg || isAllowlistBindingNoise(msg)) {
    return '';
  }
  return `<div class="banner ${msg.includes('失败') || msg.includes('未找到') ? 'warn' : 'info'}">${esc(msg)}</div>`;
}

function renderOverviewStatusCard(epoch, activation) {
  const impact = getEpochImpact(epoch);
  const epochs = appState?.epochs || [];
  const pageEpochCount = getPageEpochCount();
  return `<div class="card overview-status">
    <div class="card-head">运行快照</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">激活</div><div class="kpi-value kpi-sm">${esc(activation.label)}</div></div>
      <div class="kpi"><div class="kpi-label">${ZH.epochShort || '轮次'}</div><div class="kpi-value">${epochs.length || pageEpochCount || 0}</div></div>
      <div class="kpi"><div class="kpi-label">最新</div><div class="kpi-value">${epoch ? `#${epoch.id}` : '—'}</div></div>
      <div class="kpi"><div class="kpi-label">变更</div><div class="kpi-value">${impact.changed}</div></div>
    </div>
    ${epoch ? renderDiffBadges(epoch.diffSummary) : '<div class="subtle">尚无观测轮次；时间线与详情见侧栏「观测时间线」。</div>'}
    <div class="summary-text">${esc(renderKeySummary(epoch))}</div>
  </div>`;
}

function renderOverview() {
  const activation = getActivationState();
  const epoch = getSelectedEpoch();
  const ps = ui.pageSettings || {};

  return `${renderActivationBanner(activation)}
  ${renderOverviewToolbar()}
  ${getOverviewNoticeBanner()}
  <div class="overview-cockpit">
    ${renderOverviewStatusCard(epoch, activation)}
    ${renderDevToolsSettingsCard(ps)}
    ${renderProfileSettingsCard(ps)}
    ${renderAllowlistSettingsCard(ps)}
  </div>
  <div class="hint-cards">
    <div class="hint-card"><strong>时间线</strong>侧栏「观测时间线」查看最近轮次与字段终态详情。</div>
    <div class="hint-card"><strong>对比</strong>优先关注「升级前后不一致」。「影子未写入」= 框架已采到升级前、问题在 shadowStore。</div>
    <div class="hint-card"><strong>Allowlist</strong>绑定状态在页眉；导入/清除在本页 Allowlist 区。</div>
  </div>`;
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

function renderDevToolsSettingsCard(ps) {
  const rows = DEBUG_KEYS.map(({ key, label, desc }) => {
    const on = !!ps[key];
    return `<div class="settings-row">
      <div><div>${esc(label)}</div><div class="subtle">${esc(desc)}</div></div>
      <span class="chip ${on ? 'on' : 'off'}">${on ? '已开启' : '未开启'}</span>
    </div>`;
  }).join('');

  return `<div class="card overview-panel">
    <div class="card-head">DevTools</div>
    <div class="subtle overview-panel-meta">Panel v${PANEL_VERSION}${ps.stateScopeVersion ? ` · injector v${esc(ps.stateScopeVersion)}${ps.stateScopeHooksReady ? '' : '（hook 待就绪）'}` : ''}</div>
    <div class="settings-actions">
      <button type="button" class="btn primary" id="enable-all-debug">一键开启 bizDebug</button>
      <button type="button" class="btn primary" id="enable-and-reload">一键开启并刷新</button>
      <button type="button" class="btn" id="reload-page">刷新单据页</button>
      <button type="button" class="btn" id="rediscover-hooks">重新挂 Hook</button>
    </div>
    ${rows}
  </div>`;
}

function renderProfileSettingsCard(ps) {
  const profileMode = ps.stateScopeProfile || 'auto';
  const profileDet = ps.profileDetection || {};
  const profileRows = PROFILE_OPTIONS.map(
    (opt) => `<option value="${esc(opt.value)}" ${profileMode === opt.value ? 'selected' : ''}>${esc(opt.label)}</option>`
  ).join('');

  return `<div class="card overview-panel">
    <div class="card-head">验证 Profile</div>
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
  </div>`;
}

function renderAllowlistSettingsCard(ps) {
  const allowlistStatus = ps.allowlistActive ?
      `已绑定 · ${ps.allowlistFieldCount || 0} 字段${ps.allowlistVersion ? ` · v${ps.allowlistVersion}` : ''}${ps.allowlistBoName ? ` · ${ps.allowlistBoName}` : ''}${ps.allowlistSource ? ` · ${ps.allowlistSource}` : ''}${ps.allowlistSourceHint ? ` · ${ps.allowlistSourceHint}` : ''}`
    : ps.loadedAllowlistKeys?.length ?
        `injector 已加载 [${ps.loadedAllowlistKeys.join(', ')}]，当前 bo 未匹配`
      : ps.stateScopeInstalled ?
          `未从页面 webpack 找到 *.allowlist.ts，请导入领域白名单`
        : 'injector 未挂载（bizDebug=true 后刷新）';
  const autoAllowlistOn = ps.stateScopeAutoAllowlist !== false;

  return `<div class="card overview-panel overview-panel-wide">
    <div class="card-head">Allowlist</div>
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
        <div class="subtle">关闭后不再自动从 webpack 拾取 allowlist，并清除当前过滤</div>
      </div>
      <span class="chip ${autoAllowlistOn ? 'on' : 'off'}">${autoAllowlistOn ? '自动加载' : '已关闭'}</span>
    </div>
    <div class="settings-actions">
      <button type="button" class="btn primary" id="import-allowlist-ts">导入 allowlist.ts</button>
      <input type="file" id="import-allowlist-ts-input" accept=".ts,text/plain" hidden />
      <button type="button" class="btn" id="clear-allowlist">取消 allowlist（恢复全量 Diff）</button>
      <button type="button" class="btn" id="toggle-auto-allowlist">${autoAllowlistOn ? '关闭自动加载' : '开启自动加载'}</button>
      <button type="button" class="btn" id="resync-allowlist-settings">重新加载 allowlist</button>
    </div>
    <div class="subtle" style="margin-top:6px">约定：export const allowlist = { JSON 对象 }；对象须双引号键/值，勿含 TS 类型语法。</div>
    <div class="allowlist-catalog-head">
      <div>字段清单（${ps.allowlistFieldCount || 0}）</div>
      <div class="subtle">${ps.allowlistBoName ? esc(ps.allowlistBoName) : '—'}${ps.allowlistVersion ? ` · v${esc(ps.allowlistVersion)}` : ''}</div>
    </div>
    ${renderAllowlistCatalog(ps)}
  </div>`;
}

function renderSettings() {
  const msg = ui.settingsMessage && (ui.settingsMessage.includes('Jira') || ui.settingsMessage.includes('jira')) ?
      `<div class="banner ${ui.settingsMessage.includes('失败') ? 'warn' : 'info'}">${esc(ui.settingsMessage)}</div>`
    : '';
  return `${msg}
  <div class="card">
    <div class="card-head">设置</div>
    <div class="subtle">DevTools / Profile / Allowlist 已迁至「概览」。本页仅保留 Jira 同步配置。</div>
  </div>
  ${window.StateScopeIssuesUI ? window.StateScopeIssuesUI.renderJiraSettings(getIssuesCtx()) : '<div class="empty">Issues UI 未加载</div>'}`;
}

function needsAllowlistCatalogFields() {
  return ui.tab === 'overview';
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
      if (ui.tab === 'overview' || ui.tab === 'settings') {
        await readPageSettings({ includeAllowlistFields: needsAllowlistCatalogFields() });
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
  CONSOLE_FILTER_PRESETS.forEach((item) => {
    document.getElementById(item.id)?.addEventListener('click', () => {
      copyText(item.filter);
      showToast(`已复制过滤词：${item.filter}`);
    });
  });
  document.getElementById('action-export-snapshot')?.addEventListener('click', exportDiagnosticJson);
  document.getElementById('action-clear-cache')?.addEventListener('click', clearStateScopeCache);
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
      ${RESOLVE_STATE_SCOPE}
      var ss = __ssResolve();
      if (!ss || !ss.rediscover) {
        return { ok: false, error: 'injector 未就绪，请先刷新单据页（或 top.__StateScope__）' };
      }
      var meta = ss.rediscover();
      if (ss.syncPanelState) ss.syncPanelState();
      var diag = ss.getDiagnostics ? ss.getDiagnostics() : {};
      return {
        ok: true,
        boName: meta && meta.boName,
        profile: meta && meta.profile,
        lowcodeViewModel: !!(diag && diag.lowcodeViewModel),
        mdfDoDispatch: !!(diag && diag.mdfDoDispatch),
        mdfGetDisableHook: !!(diag && diag.mdfGetDisableHook),
        stateManager: !!(diag && diag.stateManager),
        formController: !!(diag && diag.formController)
      };
    })()`);
    if (response.ok && response.result?.ok !== false) {
      const profile = response.result.profile || ui.pageSettings?.pageMeta?.profile || '—';
      ui.settingsMessage =
        profile === 'lowcode' ?
          `Hook 已重挂（lowcode）：boName=${response.result.boName || '—'} · viewModel=${response.result.lowcodeViewModel ? '✓' : '✗'} · doDispatch=${response.result.mdfDoDispatch ? '✓' : '✗'}。请选单/改表头触发观测轮次。`
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

  document.getElementById('import-allowlist-ts')?.addEventListener('click', () => {
    document.getElementById('import-allowlist-ts-input')?.click();
  });
  document.getElementById('import-allowlist-ts-input')?.addEventListener('change', async (event) => {
    const file = event.target?.files?.[0];
    event.target.value = '';
    const result = await importAllowlistTsFile(file);
    if (!result.ok) {
      ui.settingsMessage = result.error || '导入失败';
      showToast(ui.settingsMessage);
    } else {
      await readPageSettings({ includeAllowlistFields: true });
      lastRefreshFingerprint = '';
    }
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
      ui.settingsMessage =
        result.error ||
        'allowlist 加载失败，请 chrome://extensions 重载 StateScope、F5 单据页，并确认 bizDebug=true';
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
      await refresh({ force: true, reason: 'user' });
    });
  });
}

function shouldLoadFullPageSync(force) {
  if (!ui.pageSettings?.stateScopeInstalled) {
    return false;
  }

  const summaryCount = ui.pageSettings?.pageSyncEpochCount ?? 0;
  const latestId = ui.pageSettings?.pageSyncSummary?.latestEpochId ?? null;
  const cachedCount = ui.pageSettings?.pageSync?.epochs?.length || 0;
  const summaryAheadOfCache = summaryCount > cachedCount;
  const hasNewEpochSignal =
    summaryAheadOfCache ||
    summaryCount !== lastPageSyncEpochCount ||
    (latestId != null && latestId !== lastPayloadSyncedLatestEpochId);
  const needsEpochUi = ['overview', 'timeline', 'diff', 'scenarios'].includes(ui.tab);
  const missingEpochs =
    needsEpochUi &&
    (!ui.pageSettings?.pageSync?.epochs?.length || !(appState?.epochs?.length));

  // SS_STATE_UPDATED / 手动 force：缺缓存时立即拉全量，否则时间线有、场景无
  if (force && (summaryAheadOfCache || missingEpochs || (needsEpochUi && summaryCount > 0 && !cachedCount))) {
    return true;
  }

  if (!hasNewEpochSignal && !missingEpochs) {
    return false;
  }

  // 摘要已领先缓存：必须立刻补全量，否则时间线与场景会脱节
  if (summaryAheadOfCache) {
    return true;
  }

  // 其余情况节流，避免 force 风暴卡死 UI
  const now = Date.now();
  if (now - lastFullPageSyncAt < FULL_PAGE_SYNC_MIN_MS) {
    return false;
  }
  return true;
}

async function refresh({ force = false, reason = 'timer' } = {}) {
  // 历史调用只传 force:true：视为用户意图，允许在内容指纹未变时也重绘（切 Tab / 点场景）
  if (force && reason === 'timer') {
    reason = 'user';
  }
  if (refreshInFlight) {
    pendingRefresh = true;
    pendingRefreshForce = pendingRefreshForce || force;
    if (reason === 'push' || reason === 'user') {
      pendingRefreshReason = reason;
    }
    return;
  }
  refreshInFlight = true;
  try {
    await readPageSettings({ includeAllowlistFields: needsAllowlistCatalogFields() });

    if (ui.pageSettings?.scenarioTagMismatch) {
      await evalInPage('window.__StateScope__?.reconcileScenarioTag?.()');
      await readPageSettings({ includeAllowlistFields: needsAllowlistCatalogFields() });
    }

    // 无 active tag 时 Epoch 不进场景累计 → Checklist 永久未开始；补绑 catalog 首项
    if (
      ui.pageSettings?.stateScopeInstalled &&
      !ui.pageSettings?.scenarioTag &&
      (ui.scenarioCatalog?.scenarios?.length || appState?.scenarioCatalogPack?.scenarios?.length)
    ) {
      await evalInPage(`window.__StateScope__?.ensureActiveScenarioTag?.()`);
      await readPageSettings({ includeAllowlistFields: needsAllowlistCatalogFields() });
      if (ui.pageSettings?.scenarioTag) {
        ui.scenarioTag = ui.pageSettings.scenarioTag;
        ui.selectedScenarioTag = ui.selectedScenarioTag || ui.pageSettings.scenarioTag;
      }
    }

    // 轻量摘要够判断是否有新轮次；全量只在确实需要时拉（含节流）
    // 定时心跳不强制拉全量 pageSync，优先靠 SW 推送
    const wantFullSync = force || reason === 'push' || reason === 'user';
    if (shouldLoadFullPageSync(wantFullSync) && ui.pageSettings?.stateScopeInstalled) {
      await readPageSyncFull();
    }

    await loadState();
    applyPageSyncToAppState();

    // 先保证 SW 有 catalog，再按 epochs 重算场景
    await ensureLocalScenarioCatalog();
    await syncScenarioCatalogToBackground();

    const didPageSync = await syncFromPageIfNeeded();
    // bulk 已带回 scenarioReport：二次 loadState 可能因消息失败丢报告，必须保住
    const reportFromBulk = didPageSync ? appState?.scenarioReport : null;
    if (didPageSync) {
      ui.ignoreStateUpdatedUntil = Date.now() + 400;
    }
    await loadState();
    if (reportFromBulk?.scenarios) {
      appState.scenarioReport = reportFromBulk;
    }
    applyPageSyncToAppState();
    maybeSelectLatestEpoch();

    if (window.StateScopeIssuesUI) {
      await window.StateScopeIssuesUI.readScenarioFromPage(getPanelCtx());
    }
    await syncAllowlistToPage();
    hydrateScenarioReportFromCatalog();

    // 局部：页眉/角标可每轮更新，不动主区 DOM
    renderChrome();
    updateCutoverNavBadge();
    updateIssuesNavBadge();
    window.StateScopeScenarioUI?.updateNavBadge(getPanelCtx());

    const fp = buildRefreshFingerprint();
    const contentChanged = fp !== lastRefreshFingerprint;
    // 定时心跳：内容没变绝不重绘主区；推送/用户操作：内容变才重绘（不再因 force 盲目整页刷）
    const shouldPaintMain =
      contentChanged || deferredPanelRedraw || (force && reason === 'user');

    if (shouldPaintMain) {
      const painted = renderMainPanelPreservingView({
        allowDuringSelection: reason === 'user'
      });
      if (painted) {
        lastRefreshFingerprint = fp;
        bindAppEvents();
      }
    } else {
      lastRefreshFingerprint = fp;
    }
  } finally {
    refreshInFlight = false;
    if (pendingRefresh) {
      const nextForce = pendingRefreshForce;
      const nextReason = pendingRefreshReason || 'timer';
      pendingRefresh = false;
      pendingRefreshForce = false;
      pendingRefreshReason = 'timer';
      setTimeout(() => {
        refresh({ force: nextForce, reason: nextReason });
      }, 120);
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

function scheduleRefreshFromStateUpdated() {
  if (Date.now() < (ui.ignoreStateUpdatedUntil || 0)) {
    return;
  }
  if (stateUpdatedRefreshTimer) {
    clearTimeout(stateUpdatedRefreshTimer);
  }
  stateUpdatedRefreshTimer = setTimeout(() => {
    stateUpdatedRefreshTimer = null;
    // 推送驱动：不 force，靠内容指纹决定是否重绘主区
    refresh({ force: false, reason: 'push' });
  }, 280);
}

function init() {
  tabId = chrome.devtools?.inspectedWindow?.tabId ?? null;
  bindTabs();
  bindEpochSelection();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SS_STATE_UPDATED' && message.tabId === tabId) {
      scheduleRefreshFromStateUpdated();
    }
  });

  // 划选结束后补上被推迟的重绘
  document.addEventListener('selectionchange', () => {
    if (!deferredPanelRedraw || hasLiveTextSelectionInPanel()) {
      return;
    }
    deferredPanelRedraw = false;
    const scroll = capturePanelScrollState();
    renderMainPanel();
    restorePanelScrollState(scroll);
    bindAppEvents();
    lastRefreshFingerprint = buildRefreshFingerprint();
  });

  refresh({ force: true, reason: 'user' });
  refreshTimerId = setInterval(() => {
    if (runtimeMessageFailures >= MAX_RUNTIME_MESSAGE_FAILURES) {
      return;
    }
    // 兜底心跳：只同步数据/角标，内容不变不重绘主区
    refresh({ force: false, reason: 'timer' });
  }, document.hidden ? PANEL_REFRESH_HIDDEN_MS : PANEL_REFRESH_MS);
}

init();
