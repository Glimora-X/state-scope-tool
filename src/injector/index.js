import {
  LOG_PREFIX,
  canActivate,
  getActivationDiagnostics,
  isBizDebugEnabled,
  isRuntimeReady,
  warnIfNonLocalhostActive
} from './activate.js';
import { detectProfile, getRuntimeMeta } from './detect.js';
import { createEpochManager, reportEpochToConsole, resetEpochCounter } from './console-reporter.js';
import {
  discoverRuntimeTargets,
  isWrapped,
  resolveBoNameFromRoute
} from './discover.js';
import { wrapDispatchAction, wrapComputeInitialStates } from './wrap-new.js';
import { wrapUiStateController } from './wrap-old.js';
import {
  discoverMdfBizApplication,
  discoverLowcodeCard,
  discoverLowcodeInterlayer,
  resolveLowcodeUiRoot,
  wrapLowcodeRuntime,
  commitLowcodeEpoch,
  probeLowcodeShadow,
  resetBootstrapState,
  requestBootstrapResample,
  getBootstrapStatus
} from './wrap-lowcode.js';
import { resetSession, getSessionToken } from './lowcode-buffer.js';
import { setForcedProfileMode, getForcedProfileMode } from './profile-registry.js';
import { getProfileDetection } from './detect.js';
import { wrapFormController } from './wrap-consume.js';
import { installDebugApi, clearEpochStore } from './debug-store.js';
import {
  getHookLiveness,
  unwrapAll,
  unwrapHook,
  verifyHookIntegrity,
  clearRegistry
} from './hook-registry.js';
import { scopeLog } from './safe-log.js';
import { isConsoleOutputEnabled } from './path-filter.js';
import { buildAllowlistPathSet } from './allowlist-config.js';
import { scanAllowlistByBoName, diagnoseAllowlistScan } from './discover-allowlist-modules.js';
import {
  applyScenarioCatalog,
  bootstrapScenarioCatalog,
  bootstrapScenarioCatalogFromDom,
  getScenarioCatalog,
  getScenarioCatalogPack,
  getScenarioCatalogSummary,
  getScenarioDiagnostics,
  getScenarioTag,
  ensureActiveScenarioTag,
  reconcileScenarioTagForBo,
  resolvePageScenarioPack,
  setScenarioTag
} from './scenario-context.js';
import { buildRuntimePayload } from './panel-payload.js';
import { getPanelSyncPayload, getPanelSyncSummary, publishRuntimeToPanel, republishCachedPanelState } from './panel-post.js';
import { clearPanelSyncCache } from './panel-sync-cache.js';

const allowlistCache = new Map();
const allowlistConfigCache = new Map();
/** @type {Map<string, { source: string, sourceHint?: string, moduleId?: string }>} */
const allowlistSourceCache = new Map();
let epochManager = null;
let runtimeContext = {};
let installed = false;
let apiInstalled = false;
let hooksInstalled = false;
let noDebugNoticeShown = false;
let lastDiscoverAt = 0;

function installScenarioCatalogBridge() {
  if (window.__stateScopeScenarioCatalogBridge__) {
    return;
  }
  window.__stateScopeScenarioCatalogBridge__ = true;
  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (data?.channel !== 'StateScopeScenarioCatalog' || !data.config) {
      return;
    }
    const boName = data.config.boName || getRuntimeMeta(runtimeContext).boName;
    if (applyScenarioCatalog(data.config, boName)) {
      try {
        document.documentElement.setAttribute(
          'data-state-scope-scenario-catalog',
          JSON.stringify(getScenarioCatalogPack(boName))
        );
      } catch {
        // ignore
      }
      reconcileScenarioTagForBo(boName);
    }
  });
}

function ensureScenarioFromWindowRegistry(boName) {
  if (!boName) {
    return false;
  }
  try {
    const { pack, source, error } = resolvePageScenarioPack(boName);
    if (error === 'normalize-failed') {
      if (isConsoleOutputEnabled()) {
        scopeLog(`${LOG_PREFIX} scenario registry normalize failed for ${boName}`);
      }
      return false;
    }
    if (!pack?.scenarios?.length) {
      return false;
    }
    // resolvePageScenarioPack 对 ① 已覆盖 ②；此处再 apply 保证 tag 初始化
    const ok = applyScenarioCatalog(pack, boName);
    if (ok && isConsoleOutputEnabled()) {
      scopeLog(
        `scenario catalog loaded: ${boName} v${pack.version || '?'} epoch=${pack.catalogEpoch || '?'} (${pack.scenarios.length} scenarios) [${source || pack.source || '?'}]`
      );
    }
    return ok;
  } catch {
    return false;
  }
}

function bootstrapScenarioForRuntime(boName) {
  ensureScenarioFromWindowRegistry(boName);
  bootstrapScenarioCatalog(boName);
  bootstrapScenarioCatalogFromDom(boName);
  return reconcileScenarioTagForBo(boName);
}
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 120;
const DISCOVER_INTERVAL_MS = 2000;

function normalizeAllowlistConfig(config) {
  if (!config?.fields?.length) {
    return config;
  }
  return {
    ...config,
    fields: config.fields.map((field) => ({
      ...field,
      stateType: field.stateType || 'disabled'
    }))
  };
}

function resolveAllowlistConfig(boName) {
  if (boName && allowlistConfigCache.has(boName)) {
    return allowlistConfigCache.get(boName);
  }
  if (!boName && allowlistConfigCache.size === 1) {
    return [...allowlistConfigCache.values()][0];
  }
  if (!boName && allowlistConfigCache.has('GoodsIssue')) {
    return allowlistConfigCache.get('GoodsIssue');
  }
  return undefined;
}

/**
 * 领域仓 bizDebug 自注册：window.__STATE_SCOPE_ALLOWLISTS__[boName]
 * （绕过 MF remote / JSON 内联导致的 webpack 扫描失效）
 */
function readAllowlistFromWindowRegistry(boName) {
  try {
    const reg = window.__STATE_SCOPE_ALLOWLISTS__;
    if (!reg || typeof reg !== 'object') {
      return null;
    }
    const cfg = boName ? reg[boName] : null;
    if (cfg?.boName && Array.isArray(cfg.fields) && cfg.fields.length > 0) {
      return cfg;
    }
    return null;
  } catch {
    return null;
  }
}

function ensureAllowlistForBoName(boName) {
  if (!boName || !isAutoAllowlistEnabled()) {
    return { applied: false, reason: 'no-bo' };
  }

  const current = resolveAllowlistConfig(boName);
  const currentSource = allowlistSourceCache.get(boName)?.source;

  // 优先：领域自注册（window-registry）— SSOT，可刷新覆盖 webpack 旧缓存
  const fromRegistry = readAllowlistFromWindowRegistry(boName);
  if (fromRegistry) {
    if (current?.boName === boName && currentSource === 'window-registry') {
      // 内容可能更新：仍 apply 一次以同步 fields
      applyAllowlistConfig(fromRegistry, {
        source: 'window-registry',
        sourceHint: `${boName} ← __STATE_SCOPE_ALLOWLISTS__`
      });
      return {
        applied: true,
        reason: 'already-bound',
        boName,
        source: 'window-registry',
        sourceHint: allowlistSourceCache.get(boName)?.sourceHint
      };
    }
    applyAllowlistConfig(fromRegistry, {
      source: 'window-registry',
      sourceHint: `${boName} ← __STATE_SCOPE_ALLOWLISTS__`
    });
    return {
      applied: true,
      reason: 'window-registry',
      boName: fromRegistry.boName || boName,
      source: 'window-registry',
      sourceHint: `${boName} ← __STATE_SCOPE_ALLOWLISTS__`
    };
  }

  if (current?.boName === boName && currentSource === 'webpack-source') {
    return {
      applied: true,
      reason: 'already-bound',
      boName,
      source: 'webpack-source',
      sourceHint: allowlistSourceCache.get(boName)?.sourceHint
    };
  }

  const fromWebpack = scanAllowlistByBoName(boName);
  if (fromWebpack?.config) {
    applyAllowlistConfig(fromWebpack.config, {
      source: 'webpack-source',
      sourceHint: fromWebpack.sourceHint,
      moduleId: fromWebpack.moduleId
    });
    return {
      applied: true,
      reason: 'webpack-source',
      boName: fromWebpack.config.boName || boName,
      source: 'webpack-source',
      sourceHint: fromWebpack.sourceHint
    };
  }

  if (current?.boName === boName) {
    return {
      applied: true,
      reason: 'already-bound',
      boName,
      source: currentSource || 'cache'
    };
  }

  // registry / webpack / DOM 均未命中 → 引导概览页手工导入
  return { applied: false, reason: 'need-import', boName };
}

function installAllowlistRegistryBridge() {
  if (window.__stateScopeAllowlistRegistryBridge__) {
    return;
  }
  window.__stateScopeAllowlistRegistryBridge__ = true;

  const onRegister = (event) => {
    const boName = event?.detail?.boName || getRuntimeMeta(runtimeContext).boName;
    if (!boName) {
      return;
    }
    if (isAutoAllowlistEnabled()) {
      ensureAllowlistForBoName(boName);
    }
    bootstrapScenarioForRuntime(boName);
  };

  // 统一事件：领域 publishStateScopeForDebug 一次派发
  window.addEventListener('statescope:register', onRegister);
  // 兼容仅 allowlist 的旧事件
  window.addEventListener('statescope:allowlist', onRegister);
}

function resolveAllowlistPathSet(boName) {
  const config = resolveAllowlistConfig(boName);
  return config ? allowlistCache.get(config.boName) : undefined;
}

function getAllowlistConfigForRuntime() {
  return resolveAllowlistConfig(getRuntimeMeta(runtimeContext).boName);
}

function getAllowlistSourceMeta(boName) {
  const key = boName || getRuntimeMeta(runtimeContext).boName;
  if (!key) {
    return null;
  }
  return allowlistSourceCache.get(key) || null;
}

function applyAllowlistConfig(config, meta = {}) {
  const normalized = normalizeAllowlistConfig(config);
  if (!normalized?.boName) {
    return false;
  }
  allowlistConfigCache.set(normalized.boName, normalized);
  allowlistCache.set(normalized.boName, buildAllowlistPathSet(normalized));
  const source = meta.source || normalized.__source || 'external';
  const sourceHint = meta.sourceHint || normalized.__sourceHint || '';
  const moduleId = meta.moduleId || normalized.__moduleId || '';
  allowlistSourceCache.set(normalized.boName, { source, sourceHint, moduleId });
  if (isConsoleOutputEnabled()) {
    const hint = sourceHint ? ` · ${sourceHint}` : '';
    scopeLog(
      `allowlist loaded: ${normalized.boName} v${normalized.version || '?'} (${normalized.fields?.length || 0} fields) [${source}${hint}]`
    );
  }
  try {
    window.postMessage(
      {
        channel: 'StateScopeInternal',
        type: 'allowlistAck',
        boName: normalized.boName,
        version: normalized.version || '',
        source,
        sourceHint
      },
      window.location.origin
    );
  } catch {
    // ignore
  }
  return true;
}

function readAllowlistFromDom() {
  try {
    const raw = document.documentElement?.getAttribute('data-state-scope-allowlist');
    if (!raw) {
      return false;
    }
    return applyAllowlistConfig(JSON.parse(raw), { source: 'dom' });
  } catch {
    return false;
  }
}

function bootstrapAllowlists() {
  if (!isAutoAllowlistEnabled()) {
    return { source: 'disabled', applied: false };
  }

  installAllowlistRegistryBridge();
  readAllowlistFromDom();
  drainPendingAllowlists();

  if (isBizDebugEnabled() && !runtimeContext.boName) {
    maybeDiscoverRuntimeTargets();
  }

  const boName = isBizDebugEnabled() ? getRuntimeMeta(runtimeContext).boName : '';
  if (boName) {
    const ensured = ensureAllowlistForBoName(boName);
    if (ensured.applied) {
      return {
        source: ensured.reason,
        applied: true,
        boName: ensured.boName || boName,
        sourceHint: ensured.sourceHint || allowlistSourceCache.get(boName)?.sourceHint || ''
      };
    }
  }

  // 禁止在未知 boName 时 fallback GoodsIssue（低代码页会被误绑）
  if (allowlistConfigCache.size > 0 && boName) {
    const current = resolveAllowlistConfig(boName);
    if (current?.boName === boName) {
      return {
        source: 'cache',
        applied: true,
        boName,
        sourceHint: allowlistSourceCache.get(boName)?.sourceHint || ''
      };
    }
  }

  return { source: 'none', applied: false, boName };
}

function requestAllowlistFromBridge() {
  // 扩展不再打包 allowlists/*.json；保留空实现以免旧调试代码调用报错
  return;
}

function drainPendingAllowlists() {
  if (!isAutoAllowlistEnabled()) {
    return 0;
  }
  const pending = window.__StateScopePendingAllowlists__;
  if (!Array.isArray(pending) || !pending.length) {
    return 0;
  }
  let applied = 0;
  while (pending.length) {
    const config = pending.shift();
    if (applyAllowlistConfig(config, { source: 'pending' })) {
      applied += 1;
    }
  }
  return applied;
}

function isAutoAllowlistEnabled() {
  try {
    return localStorage.getItem('stateScopeAutoAllowlist') !== 'false';
  } catch {
    return true;
  }
}

function clearAllowlist(boName) {
  const target = boName || getRuntimeMeta(runtimeContext).boName;
  if (!target) {
    return false;
  }
  allowlistCache.delete(target);
  allowlistConfigCache.delete(target);
  allowlistSourceCache.delete(target);
  scopeLog(`${LOG_PREFIX} allowlist cleared: ${target} (Diff 恢复全量)`);
  return true;
}

function ensureEpochManager() {
  if (epochManager) {
    const currentBo = getRuntimeMeta(runtimeContext).boName;
    if (currentBo && epochManager.getBoName() !== currentBo) {
      epochManager.setBoName(currentBo);
    }
    return epochManager;
  }

  epochManager = createEpochManager((epoch) => {
    reportEpochToConsole(
      epoch,
      getRuntimeMeta(runtimeContext),
      getAllowlistConfigForRuntime()
    );
    publishRuntimeToPanel(buildRuntimePayload(runtimeContext));
  }, getRuntimeMeta(runtimeContext).boName);

  return epochManager;
}

function maybeDiscoverRuntimeTargets(force = false) {
  const now = Date.now();
  if (!force && lastDiscoverAt && now - lastDiscoverAt < DISCOVER_INTERVAL_MS) {
    return runtimeContext;
  }
  lastDiscoverAt = now;
  return refreshRuntimeTargets(force ? { deepScan: true } : undefined);
}

function handleBoSwitch(oldBo, newBo) {
  unwrapAll();
  clearRegistry();

  const newToken = `${newBo}-${Date.now()}`;
  resetSession(newToken);
  resetBootstrapState();
  hooksInstalled = false;
  installed = false;
  resetEpochCounter();
  epochManager = null;

  // 多 Tab：保留各 BO 已加载的 allowlist 缓存，只切换「当前」绑定（不再清空其它 BO）
  // 若其它 Tab 再次点开，可直接 listLoadedAllowlists 命中，无需等再次 publish

  if (isConsoleOutputEnabled()) {
    scopeLog(`${LOG_PREFIX} BO switched: ${oldBo} → ${newBo}, session=${newToken}`);
  }
}

function refreshRuntimeTargets(discoverOptions) {
  const prevBoName = runtimeContext.boName;
  const routeBo = resolveBoNameFromRoute();
  const useDeep =
    discoverOptions?.deepScan === true ||
    (getForcedProfileMode() === 'lowcode' || runtimeContext.profile === 'lowcode') && routeBo;

  runtimeContext = {
    ...runtimeContext,
    ...discoverRuntimeTargets(useDeep ? { deepScan: true } : discoverOptions)
  };
  const meta = getRuntimeMeta(runtimeContext);
  runtimeContext.profile = meta.profile;
  runtimeContext.profileDetection = meta.profileDetection;
  // 强制与路由对齐，避免 discover 返回残留 bizApplication.boName
  runtimeContext.boName = meta.boName || routeBo || runtimeContext.boName;

  if (prevBoName && runtimeContext.boName && prevBoName !== runtimeContext.boName) {
    handleBoSwitch(prevBoName, runtimeContext.boName);
    ensureAllowlistForBoName(runtimeContext.boName);
    bootstrapScenarioForRuntime(runtimeContext.boName);
    publishRuntimeToPanel(buildRuntimePayload(runtimeContext));
    if (isConsoleOutputEnabled()) {
      console.info(
        `${LOG_PREFIX} active | boName=${runtimeContext.boName} | profile=${runtimeContext.profile} (switched)`
      );
    }
    return runtimeContext;
  }

  if (runtimeContext.boName) {
    ensureAllowlistForBoName(runtimeContext.boName);
  }
  return runtimeContext;
}

function installHooks() {
  // 低代码：viewModel / Card / BizApplication 可能分批就绪，允许补装
  if (hooksInstalled) {
    if (runtimeContext.profile === 'lowcode' && runtimeContext.viewModel) {
      const vm = runtimeContext.viewModel;
      const mdfBiz = discoverMdfBizApplication(vm);
      const interlayer = discoverLowcodeInterlayer(vm, mdfBiz);
      const uiRoot = resolveLowcodeUiRoot(vm, mdfBiz);
      const needGetDisable = uiRoot && !uiRoot.__stateScopeUiReaderHooked;
      const needDoDispatch = mdfBiz && !isWrapped(mdfBiz);
      const needSyncChangedFields =
        interlayer && typeof interlayer.syncChangedFields === 'function' && !isWrapped(interlayer);
      const needAfterBizAction =
        uiRoot && typeof uiRoot.execute === 'function' && !uiRoot.__stateScopeAfterBizWrapped;
      if (!needGetDisable && !needDoDispatch && !needSyncChangedFields && !needAfterBizAction) {
        return 0;
      }
      // fall through to wrap lowcode
    } else {
      return 0;
    }
  }

  const manager = ensureEpochManager();
  const profile = runtimeContext.profile || 'unknown';
  const detection = runtimeContext.profileDetection;
  const useTraditional = profile === 'traditional';
  const useLowcode = profile === 'lowcode';
  let hookCount = 0;

  // 两条迁移线严格分装：traditional ≠ lowcode，禁止串 hook / 串取证口径
  if (useTraditional) {
    if (runtimeContext.bizApplication?.stateManager && !isWrapped(runtimeContext.bizApplication)) {
      if (wrapDispatchAction(runtimeContext.bizApplication, manager)) {
        hookCount += 1;
      }
      if (wrapComputeInitialStates(runtimeContext.bizApplication.stateManager, manager)) {
        hookCount += 1;
      }
    }

    if (runtimeContext.formController && !isWrapped(runtimeContext.formController)) {
      wrapFormController(runtimeContext.formController, manager);
      hookCount += 1;
    } else if (runtimeContext.uiStateController && !isWrapped(runtimeContext.uiStateController)) {
      wrapUiStateController(runtimeContext.uiStateController, manager, runtimeContext.presenter);
      hookCount += 1;
    }
  }

  if (useLowcode && runtimeContext.viewModel) {
    const lowcodeHooks = wrapLowcodeRuntime(runtimeContext.viewModel, manager, () => ({
      viewModel: runtimeContext.viewModel,
      allowlistConfig: getAllowlistConfigForRuntime(),
      boName: getRuntimeMeta(runtimeContext).boName
    }));
    if (
      lowcodeHooks.getDisable ||
      lowcodeHooks.doDispatch ||
      lowcodeHooks.syncChangedFields ||
      lowcodeHooks.afterBizAction
    ) {
      hookCount += 1;
    }
    scopeLog(`${LOG_PREFIX} lowcode hooks`, lowcodeHooks);
  }

  if (detection?.profile === 'hybrid' && isConsoleOutputEnabled()) {
    scopeLog(
      `hybrid runtime detected (${detection.reason}); effective profile=${profile}. ` +
        'Set stateScopeProfile=traditional|lowcode if results look wrong.'
    );
  }

  if (hookCount > 0) {
    hooksInstalled = true;
    if (isConsoleOutputEnabled()) {
      console.info(
        `${LOG_PREFIX} hooks installed (${hookCount}) | profile=${profile} | viewModel=${!!runtimeContext.viewModel} | boName=${getRuntimeMeta(runtimeContext).boName || '—'}`
      );
    }
  }

  return hookCount;
}

function mirrorStateScopeApiToTop() {
  try {
    if (window.top && window.top !== window && window.__StateScope__) {
      window.top.__StateScope__ = window.__StateScope__;
    }
  } catch {
    // cross-origin top
  }
}

/** bizDebug 开启后立即暴露 Debug API，不等待 viewModel / hook 就绪 */
function ensureStateScopeApi() {
  if (apiInstalled && window.__StateScope__?.version) {
    mirrorStateScopeApiToTop();
    return window.__StateScope__;
  }

  apiInstalled = true;
  window.__StateScope__ = {
    installed: false,
    version: '0.8.38',
    mode: 'P2-lowcode-capture',
    getMeta: () => getRuntimeMeta(runtimeContext),
    getDiagnostics: () => getActivationDiagnostics(runtimeContext),
    getHookStatus: () => ({
      installed: !!installed,
      hooksInstalled: !!hooksInstalled,
      profile: runtimeContext.profile || 'unknown',
      boName: getRuntimeMeta(runtimeContext).boName || '',
      lowcodeViewModel: !!runtimeContext.viewModel,
      diagnostics: getActivationDiagnostics(runtimeContext)
    }),
    rediscover: () => {
      lastDiscoverAt = 0;
      refreshRuntimeTargets({ deepScan: true });
      hooksInstalled = false;
      installHooks();
      bootstrapAllowlists();
      bootstrapScenarioForRuntime(getRuntimeMeta(runtimeContext).boName);
      return getRuntimeMeta(runtimeContext);
    },
    getAllowlist: () => resolveAllowlistPathSet(getRuntimeMeta(runtimeContext).boName),
    getAllowlistConfig: () => getAllowlistConfigForRuntime(),
    getAllowlistSource: () => getAllowlistSourceMeta(),
    diagnoseAllowlistScan: (boName) =>
      diagnoseAllowlistScan(boName || getRuntimeMeta(runtimeContext).boName),
    listLoadedAllowlists: () => [...allowlistConfigCache.keys()],
    applyAllowlistConfig(config, meta) {
      return applyAllowlistConfig(config, meta);
    },
    reloadAllowlist() {
      readAllowlistFromDom();
      drainPendingAllowlists();
      const boName = getRuntimeMeta(runtimeContext).boName;
      const boot = bootstrapAllowlists();
      return {
        config: getAllowlistConfigForRuntime(),
        loadedKeys: [...allowlistConfigCache.keys()],
        boot,
        source: getAllowlistSourceMeta(boName)
      };
    },
    clearAllowlist(boName) {
      return clearAllowlist(boName);
    },
    isAutoAllowlistEnabled: () => isAutoAllowlistEnabled(),
    setAutoAllowlistEnabled(enabled) {
      localStorage.setItem('stateScopeAutoAllowlist', enabled ? 'true' : 'false');
      if (!enabled) {
        clearAllowlist(getRuntimeMeta(runtimeContext).boName);
      }
      return isAutoAllowlistEnabled();
    },
    getDiffModel: () => ({
      profile: runtimeContext.profile,
      axis: runtimeContext.profile === 'lowcode'
        ? { oldSide: 'referenceSnap (旧轨)', newSide: 'shadowSnap (新轨/migrated)', description: '旧状态 vs 新状态（lifecycle 无关）' }
        : { oldSide: 'oldSnap', newSide: 'newSnap', description: '操作前 vs 操作后' }
    }),
    getProfileDetection: () => getProfileDetection(runtimeContext),
    getProfileMode: () => getForcedProfileMode(),
    setProfileMode(mode) {
      return setForcedProfileMode(mode);
    },
    getScenarioTag: () => getScenarioTag(getRuntimeMeta(runtimeContext).boName),
    setScenarioTag: (tag) => setScenarioTag(tag, getRuntimeMeta(runtimeContext).boName),
    ensureActiveScenarioTag: (boName) =>
      ensureActiveScenarioTag(boName || getRuntimeMeta(runtimeContext).boName),
    getScenarioCatalog: (boName) => getScenarioCatalog(boName || getRuntimeMeta(runtimeContext).boName),
    getScenarioCatalogPack: (boName) => getScenarioCatalogPack(boName || getRuntimeMeta(runtimeContext).boName),
    getScenarioCatalogSummary: (boName) =>
      getScenarioCatalogSummary(boName || getRuntimeMeta(runtimeContext).boName),
    getScenarioDiagnostics: (boName) =>
      getScenarioDiagnostics(boName || getRuntimeMeta(runtimeContext).boName),
    reconcileScenarioTag: (boName) =>
      reconcileScenarioTagForBo(boName || getRuntimeMeta(runtimeContext).boName),
    applyScenarioCatalog(config, boName) {
      return applyScenarioCatalog(config, boName);
    },
    bootstrapScenarioCatalog(boName) {
      return bootstrapScenarioCatalog(boName || getRuntimeMeta(runtimeContext).boName);
    },
    setAllowlist(boName, paths) {
      allowlistCache.set(boName, new Set(Array.isArray(paths) ? paths : []));
    },
    forceLowcodeSample: (trigger = 'manual') => {
      const ok = commitLowcodeEpoch(
        ensureEpochManager(),
        () => ({
          viewModel: runtimeContext.viewModel,
          allowlistConfig: getAllowlistConfigForRuntime()
        }),
        trigger,
        'incremental',
        discoverMdfBizApplication(runtimeContext.viewModel),
        { force: true }
      );
      return { ok, hooks: getActivationDiagnostics(runtimeContext) };
    },
    /** 重新采集空白/初始态（setup「新增空白单据」时用） */
    resampleBootstrap: () => {
      const em = ensureEpochManager();
      const ok = requestBootstrapResample(
        em,
        () => ({
          viewModel: runtimeContext.viewModel,
          allowlistConfig: getAllowlistConfigForRuntime()
        }),
        discoverMdfBizApplication(runtimeContext.viewModel)
      );
      return { ok, bootstrap: getBootstrapStatus() };
    },
    probeShadow: () =>
      probeLowcodeShadow(
        runtimeContext.viewModel,
        getAllowlistConfigForRuntime(),
        discoverMdfBizApplication(runtimeContext.viewModel)
      ),
    forceFinalize: () => ensureEpochManager().finalizeEpoch(),
    getBoSessionToken: () => getSessionToken(),
    getPanelSyncPayload: () => getPanelSyncPayload(),
    getPanelSyncSummary: () => getPanelSyncSummary(),
    syncPanelState: () => republishCachedPanelState(),
    clearPanelCache() {
      clearPanelSyncCache();
      clearEpochStore();
      resetEpochCounter();
      // 故意不碰 bizDebug / stateScopeVerbose / stateScopeDebug / stateScopeProfile / allowlist
      // 激活场景在 localStorage；重置为 catalog 首项（不 localStorage.clear）
      const boName = getRuntimeMeta(runtimeContext).boName;
      setScenarioTag('', boName);
      const scenarioTag = ensureActiveScenarioTag(boName);
      return {
        ok: true,
        scenarioTag,
        boName: boName || '',
        bizDebug: localStorage.getItem('bizDebug') === 'true'
      };
    },
    getBootstrapStatus: () => getBootstrapStatus(),
    getHookLiveness: () => getHookLiveness(),
    unwrapAll: () => unwrapAll(),
    unwrapHook: (name) => unwrapHook(name),
    verifyHookIntegrity: () => verifyHookIntegrity(),
    extensionRelayBroken: false
  };

  installDebugApi(window, scopeLog);
  installScenarioCatalogBridge();
  bootstrapScenarioForRuntime(getRuntimeMeta(runtimeContext).boName);
  mirrorStateScopeApiToTop();
  return window.__StateScope__;
}

function markInstalled() {
  const meta = getRuntimeMeta(runtimeContext);
  const api = ensureStateScopeApi();
  api.installed = true;

  bootstrapAllowlists();
  const scenarioBoot = bootstrapScenarioForRuntime(meta.boName);
  publishRuntimeToPanel(buildRuntimePayload(runtimeContext));
  republishCachedPanelState();
  mirrorStateScopeApiToTop();

  if (isConsoleOutputEnabled()) {
    if (!getScenarioCatalogPack(meta.boName)) {
      scopeLog(
        `${LOG_PREFIX} 场景包未加载：Panel → 场景回归 → 上传 ${meta.boName}.scenarios.v1.json`
      );
    }
    if (scenarioBoot.cleared || scenarioBoot.reason === 'auto-set-first-scenario') {
      scopeLog(`${LOG_PREFIX} scenarioTag reconciled`, scenarioBoot);
    }
    console.info(
      `${LOG_PREFIX} active | boName=${meta.boName || '(unknown)'} | profile=${meta.profile} | route=${meta.route}`
    );
    console.info(`${LOG_PREFIX} hooks:`, {
      bizApplication: !!runtimeContext.bizApplication?.stateManager,
      presenter: !!runtimeContext.presenter,
      uiStateController: !!runtimeContext.uiStateController,
      formController: !!runtimeContext.formController,
      lowcodeViewModel: !!runtimeContext.viewModel,
      profileDetection: meta.profileDetection
    });
  }
}

function activateIfReady() {
  if (!isBizDebugEnabled()) {
    return 'no-debug';
  }

  // 低代码 viewModel 可能晚于路由 boName；未装齐 hook 前持续轻量 rediscover
  if (!installed || (runtimeContext.profile === 'lowcode' && !hooksInstalled)) {
    maybeDiscoverRuntimeTargets();
  }

  if (!canActivate(runtimeContext) && !runtimeContext.boName) {
    return 'waiting-targets';
  }

  if (!isRuntimeReady(runtimeContext)) {
    return 'waiting-targets';
  }

  if (!installed) {
    warnIfNonLocalhostActive();
  }

  installHooks();

  if (!installed) {
    installed = true;
    markInstalled();
  }

  // 低代码：仅有路由 boName、尚无 viewModel 时继续等 hook
  if (runtimeContext.profile === 'lowcode' && !runtimeContext.viewModel) {
    return 'waiting-targets';
  }

  return 'ready';
}

function logWaitingReason(attempts) {
  if (!isConsoleOutputEnabled()) {
    return;
  }

  const diag = getActivationDiagnostics(installed ? runtimeContext : maybeDiscoverRuntimeTargets());

  if (attempts === 1) {
    console.info(`${LOG_PREFIX} bizDebug ok, waiting for voucher runtime...`);
  }

  if (attempts % 15 === 0) {
    console.warn(`${LOG_PREFIX} still waiting (${attempts}/${MAX_POLL_ATTEMPTS}):`, diag);
  }
}

function lowcodeHooksIncomplete() {
  if (runtimeContext.profile !== 'lowcode' || !runtimeContext.viewModel) {
    return false;
  }
  const mdfBiz = discoverMdfBizApplication(runtimeContext.viewModel);
  const interlayer = discoverLowcodeInterlayer(runtimeContext.viewModel, mdfBiz);
  const uiRoot = resolveLowcodeUiRoot(runtimeContext.viewModel, mdfBiz);
  return (
    (uiRoot && !uiRoot.__stateScopeUiReaderHooked) ||
    (mdfBiz && !isWrapped(mdfBiz)) ||
    (interlayer &&
      typeof interlayer.syncChangedFields === 'function' &&
      !isWrapped(interlayer)) ||
    (uiRoot && typeof uiRoot.execute === 'function' && !uiRoot.__stateScopeAfterBizWrapped)
  );
}

function startPolling() {
  if (!isBizDebugEnabled()) {
    return;
  }

  let attempts = 0;

  const tick = () => {
    try {
      attempts += 1;
      const status = activateIfReady();

      if (status === 'no-debug' || status === 'ready') {
        return 'stop';
      }

      if (status === 'waiting-targets') {
        logWaitingReason(attempts);
      }

      if (attempts >= MAX_POLL_ATTEMPTS && !lowcodeHooksIncomplete()) {
        if (isConsoleOutputEnabled()) {
          console.warn(`${LOG_PREFIX} gave up after ${MAX_POLL_ATTEMPTS} attempts.`, getActivationDiagnostics(runtimeContext));
        }
        return 'stop';
      }

      if (attempts >= MAX_POLL_ATTEMPTS && lowcodeHooksIncomplete()) {
        if (attempts === MAX_POLL_ATTEMPTS && isConsoleOutputEnabled()) {
          console.warn(`${LOG_PREFIX} lowcode hooks incomplete, keep polling…`, getActivationDiagnostics(runtimeContext));
        }
      }

      return 'continue';
    } catch (error) {
      if (isConsoleOutputEnabled()) {
        console.error(`${LOG_PREFIX} activate tick failed:`, error);
      }
      return 'continue';
    }
  };

  if (tick() === 'stop') {
    return;
  }

  const timer = setInterval(() => {
    if (tick() === 'stop') {
      clearInterval(timer);
    }
  }, POLL_INTERVAL_MS);
}

function installRouteBoWatch() {
  if (window.__stateScopeRouteBoWatch__) {
    return;
  }
  window.__stateScopeRouteBoWatch__ = true;
  let lastRouteKey = `${location.pathname}${location.search}${location.hash}`;
  const onRouteChange = () => {
    const nextRouteKey = `${location.pathname}${location.search}${location.hash}`;
    const routeChanged = nextRouteKey !== lastRouteKey;
    const prevBo = runtimeContext.boName;
    lastRouteKey = nextRouteKey;
    lastDiscoverAt = 0;
    refreshRuntimeTargets({ deepScan: true });
    // 同 BO 路由变化（列表→新增空白）：重新 bootstrap，否则时间线不会有 init Epoch
    if (
      routeChanged &&
      prevBo &&
      runtimeContext.boName === prevBo &&
      runtimeContext.profile === 'lowcode' &&
      epochManager
    ) {
      requestBootstrapResample(epochManager, () => ({
        viewModel: runtimeContext.viewModel,
        allowlistConfig: getAllowlistConfigForRuntime()
      }), discoverMdfBizApplication(runtimeContext.viewModel));
      if (isConsoleOutputEnabled()) {
        scopeLog(`${LOG_PREFIX} same-BO route change → resample bootstrap`);
      }
    }
    // BO 切换后重新装 hook / 重新 active
    if (isBizDebugEnabled()) {
      activateIfReady();
    }
  };
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('popstate', onRouteChange);
}

function bootInjector() {
  if (!isBizDebugEnabled()) {
    if (!noDebugNoticeShown && isConsoleOutputEnabled()) {
      noDebugNoticeShown = true;
      console.info(
        `${LOG_PREFIX} inactive (bizDebug off). Set localStorage.bizDebug='true' and refresh.`
      );
    }
    return;
  }

  if (isConsoleOutputEnabled()) {
    console.info(`${LOG_PREFIX} injector loaded. bizDebug=true`);
    console.info(
      `${LOG_PREFIX} Debug API → __StateScope__（iframe 内 Console 请选 top 或执行 top.__StateScope__）`
    );
  }

  installAllowlistRegistryBridge();
  installRouteBoWatch();
  maybeDiscoverRuntimeTargets();
  ensureStateScopeApi();
  bootstrapAllowlists();
  startPolling();
}

window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }
  if (event.data?.channel === 'StateScopeAllowlist' && event.data.config) {
    if (isAutoAllowlistEnabled()) {
      applyAllowlistConfig(event.data.config, { source: 'bridge' });
    }
  }
  if (event.data?.channel === 'StateScopeAllowlistClear') {
    clearAllowlist(event.data.boName);
  }
  if (event.data?.channel === 'StateScopeExtensionAck' && window.__StateScope__) {
    if (event.data.ok === false) {
      window.__StateScope__.extensionRelayBroken = true;
      window.__StateScope__.extensionRelayError = event.data.error || 'relay failed';
      try {
        window.__StateScopeRelayBroken__ = true;
      } catch {
        // ignore
      }
    } else {
      window.__StateScope__.extensionRelayBroken = false;
      window.__StateScope__.extensionRelayError = '';
      try {
        window.__StateScopeRelayBroken__ = false;
      } catch {
        // ignore
      }
    }
  }
});

bootInjector();
