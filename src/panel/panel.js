const ui = {
  tab: 'overview',
  selectedEpochId: null,
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
  scenarioTag: '',
  issueStatusFilter: '',
  issueSyncFilter: '',
  selectedIssueFps: null,
  selectedScenarioTag: 'edit'
};

const DEBUG_KEYS = [
  { key: 'bizDebug', label: 'bizDebug', desc: '必须，激活 StateScope' },
  { key: 'stateScopeVerbose', label: 'stateScopeVerbose', desc: '输出完整 oldSnap/newSnap' },
  { key: 'stateScopeDebug', label: 'stateScopeDebug', desc: '写入 __StateScope__.getLastEpoch()' }
];

let tabId = null;
let appState = null;
let dataSource = 'background';

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
  if (pageEpochs.length >= bgEpochCount) {
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
    if (!ui.selectedEpochId) {
      ui.selectedEpochId = appState.selectedEpochId || pageEpochs[0]?.id || null;
    }
    return true;
  }

  dataSource = bgEpochCount > 0 ? 'background' : dataSource;
  return false;
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
  const id = ui.selectedEpochId ?? appState.selectedEpochId ?? appState.epochs[0].id;
  return appState.epochs.find((item) => item.id === id) || appState.epochs[0];
}

async function loadState() {
  if (tabId == null) {
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SS_GET_STATE', tabId });
    appState = response?.state || {
      runtime: null,
      epochs: [],
      selectedEpochId: null,
      issues: [],
      settings: {}
    };
    appState._bgEpochCount = appState.epochs?.length || 0;
  } catch {
    appState = appState || {
      runtime: null,
      epochs: [],
      selectedEpochId: null,
      issues: [],
      settings: {}
    };
  }
  if (!ui.selectedEpochId && appState.selectedEpochId) {
    ui.selectedEpochId = appState.selectedEpochId;
  }
}

async function syncFromPageIfNeeded() {
  if (tabId == null) {
    return false;
  }

  const page = ui.pageSettings || {};
  const pageEpochCount = page.pageSync?.epochs?.length || 0;
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

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SS_BULK_SYNC',
      tabId,
      runtime: page.pageSync?.runtime || null,
      epochs: (page.pageSync?.epochs || []).map(slimEpochForBackground).filter(Boolean)
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
  await readPageSettings();
  await loadState();
  applyPageSyncToAppState();
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
  });
}

async function readPageSettings() {
  const response = await evalInPage(`({
    bizDebug: localStorage.getItem('bizDebug') === 'true',
    stateScopeVerbose: localStorage.getItem('stateScopeVerbose') === 'true',
    stateScopeDebug: localStorage.getItem('stateScopeDebug') === 'true',
    stateScopeAutoAllowlist: localStorage.getItem('stateScopeAutoAllowlist') !== 'false',
    stateScopeInstalled: !!(window.__StateScope__ && window.__StateScope__.installed),
    allowlistActive: !!(window.__StateScope__?.getAllowlistConfig?.()),
    allowlistFieldCount: window.__StateScope__?.getAllowlistConfig?.()?.fields?.length || 0,
    allowlistVersion: window.__StateScope__?.getAllowlistConfig?.()?.version || '',
    pageMeta: window.__StateScope__?.getMeta?.() || null,
    pageSync: window.__StateScope__?.getPanelSyncPayload?.() || null,
    relayBroken: window.__StateScope__?.extensionRelayBroken === true,
    relayError: window.__StateScope__?.extensionRelayError || ''
  })`);
  if (response.ok) {
    ui.pageSettings = response.result;
  }
  return response;
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
    localStorage.setItem('bizDebug', 'true');
    localStorage.setItem('stateScopeVerbose', 'true');
    localStorage.setItem('stateScopeDebug', 'true');
    return {
      bizDebug: localStorage.getItem('bizDebug') === 'true',
      stateScopeVerbose: localStorage.getItem('stateScopeVerbose') === 'true',
      stateScopeDebug: localStorage.getItem('stateScopeDebug') === 'true'
    };
  })()`);

  if (response.ok) {
    ui.pageSettings = response.result;
    ui.settingsMessage = '已写入 localStorage。请点击下方「刷新单据页」或 F5，刷新后顶栏应变为「已激活」。';
  } else {
    ui.settingsMessage = `写入失败：${response.error}`;
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

async function syncAllowlistToPage({ force = false } = {}) {
  const ps = ui.pageSettings;
  if (!force && ps && ps.stateScopeAutoAllowlist === false) {
    return;
  }

  const boName = appState?.runtime?.meta?.boName;
  if (!boName || boName === ui.lastSyncedBoName) {
    return;
  }

  const candidates = [`${boName}.v1.example.json`, 'GoodsIssue.v1.example.json'];
  for (const fileName of candidates) {
    try {
      const url = chrome.runtime.getURL(`allowlists/${fileName}`);
      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }
      const config = await response.json();
      if (config.boName && config.boName !== boName) {
        continue;
      }
      const payload = JSON.stringify(config);
      const evalResult = await evalInPage(
        `(function (config) {
          if (!window.__StateScope__?.applyAllowlistConfig) return { ok: false };
          return { ok: window.__StateScope__.applyAllowlistConfig(config), version: config.version };
        })(${payload})`
      );
      if (evalResult.ok && evalResult.result?.ok) {
        ui.lastSyncedBoName = boName;
      }
      return;
    } catch {
      // try next candidate
    }
  }
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
  const metaLine = report?.boName ?
      `${report.boName} · allowlist v${report.allowlistVersion || '—'} · new轨 ${report.hasNewChainObserved ? '已观测' : '未接入'}`
    : 'allowlist 未绑定';

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
    refresh
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
    const oldOk = diag.formController || diag.uiStateController;
    headerMeta.innerHTML = `
      <span>单据 <strong>${esc(meta.boName || '(unknown)')}</strong></span>
      <span class="sep">|</span>
      <span>Route ${esc(meta.route || '—')}</span>
      <span class="sep">|</span>
      <span>Profile ${esc(meta.profile || epoch?.meta?.profile || '—')}</span>
      <span class="sep">|</span>
      <span>old <span class="${oldOk ? 'chain-ok' : 'chain-off'}">${oldOk ? '✓' : '✗'}</span></span>
      <span>new <span class="${diag.stateManager ? 'chain-ok' : 'chain-off'}">${diag.stateManager ? '✓' : '✗'}</span></span>
    `;
  }

  const footer = document.getElementById('sidebar-footer');
  if (footer) {
    const count = appState?.epochs?.length || 0;
    const pageEpochCount = ui.pageSettings?.pageSync?.epochs?.length || 0;
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

function renderTimelineList(epochs) {
  if (!epochs.length) {
    return '<div class="empty">尚无 Epoch，请操作单据字段。</div>';
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
      const active = getSelectedEpoch()?.id === epoch.id ? ' active' : '';

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
    return '尚无 Epoch，请操作单据字段触发 refreshView。';
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
    return '<div class="empty">选择 Timeline 中的 Epoch 查看详情</div>';
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
    const msg =
      activation.level === 'wait' ?
        `StateScope ${activation.label}：${activation.hint}`
      : `StateScope 未激活：${activation.hint}。可前往「设置」一键开启后<strong>刷新单据页</strong>。`;
    return `<div class="banner warn">${msg}</div>${renderQuickActions()}`;
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

function renderApp() {
  const root = document.getElementById('app');
  if (!root) {
    return;
  }

  renderChrome();
  updateCutoverNavBadge();
  updateIssuesNavBadge();
  window.StateScopeScenarioUI?.updateNavBadge(getPanelCtx());

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
  const banner = epoch.hasNewChain ?
    ''
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
      `已加载 · ${ps.allowlistFieldCount || 0} 字段${ps.allowlistVersion ? ` · v${ps.allowlistVersion}` : ''}`
    : '未加载（Diff 全量）';
  const autoAllowlistOn = ps.stateScopeAutoAllowlist !== false;

  const msg = ui.settingsMessage ?
      `<div class="banner ${ui.settingsMessage.includes('失败') ? 'warn' : ''}">${esc(ui.settingsMessage)}</div>`
    : '';

  return `${msg}<div class="card">
    <h3>DevTools 设置</h3>
    <div class="settings-actions">
      <button type="button" class="btn primary" id="enable-all-debug">一键开启 StateScope 调试</button>
      <button type="button" class="btn" id="reload-page">刷新单据页</button>
    </div>
    ${rows}
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
  </div>
  ${window.StateScopeIssuesUI ? window.StateScopeIssuesUI.renderJiraSettings(getIssuesCtx()) : ''}`;
}

async function selectEpoch(epochId) {
  ui.selectedEpochId = Number(epochId);
  await chrome.runtime.sendMessage({ type: 'SS_SELECT_EPOCH', tabId, epochId: ui.selectedEpochId });
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

  root.querySelectorAll('[data-select-epoch]').forEach((el) => {
    el.addEventListener('click', async () => {
      await selectEpoch(el.getAttribute('data-select-epoch'));
      renderApp();
      bindAppEvents();
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

  const enableAll = document.getElementById('enable-all-debug');
  if (enableAll) {
    enableAll.addEventListener('click', async () => {
      enableAll.disabled = true;
      await enableAllDebugSettings();
      renderApp();
      bindAppEvents();
    });
  }

  document.getElementById('reload-page')?.addEventListener('click', reloadInspectedPage);

  document.getElementById('export-cutover-json')?.addEventListener('click', exportCutoverJson);
  document.getElementById('export-cutover-csv')?.addEventListener('click', exportCutoverCsv);
  document.getElementById('reset-cutover')?.addEventListener('click', resetCutoverReport);
  document.getElementById('resync-allowlist')?.addEventListener('click', async () => {
    ui.lastSyncedBoName = null;
    await syncAllowlistToPage({ force: true });
    await readPageSettings();
    showToast('已尝试重新加载 allowlist');
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
    await syncAllowlistToPage({ force: true });
    await readPageSettings();
    ui.settingsMessage = '已手动重新加载 allowlist。';
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
      if (ui.tab === 'settings') {
        await readPageSettings();
      }
      renderApp();
      bindAppEvents();
    });
  });
}

async function refresh() {
  await readPageSettings();
  await loadState();
  applyPageSyncToAppState();
  await syncFromPageIfNeeded();
  await loadState();
  applyPageSyncToAppState();
  if (window.StateScopeIssuesUI) {
    await window.StateScopeIssuesUI.readScenarioFromPage(getPanelCtx());
  }
  await syncAllowlistToPage();
  renderApp();
  bindAppEvents();
}

function init() {
  tabId = chrome.devtools?.inspectedWindow?.tabId ?? null;
  bindTabs();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SS_STATE_UPDATED' && message.tabId === tabId) {
      refresh();
    }
  });

  refresh();
  setInterval(refresh, 2000);
}

init();
