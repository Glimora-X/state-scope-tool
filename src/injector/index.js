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
  getBootstrapStatus
} from './wrap-lowcode.js';
import { resetSession, getSessionToken } from './lowcode-buffer.js';
import { setForcedProfileMode, getForcedProfileMode } from './profile-registry.js';
import { getProfileDetection } from './detect.js';
import { wrapFormController } from './wrap-consume.js';
import { installDebugApi } from './debug-store.js';
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
import { getBundledAllowlist } from './bundled-allowlists.js';
import {
  applyScenarioCatalog,
  bootstrapScenarioCatalog,
  bootstrapScenarioCatalogFromDom,
  getScenarioCatalog,
  getScenarioCatalogPack,
  getScenarioCatalogSummary,
  getScenarioDiagnostics,
  getScenarioTag,
  reconcileScenarioTagForBo,
  setScenarioTag
} from './scenario-context.js';
import { buildRuntimePayload } from './panel-payload.js';
import { getPanelSyncPayload, getPanelSyncSummary, publishRuntimeToPanel, republishCachedPanelState } from './panel-post.js';

const allowlistCache = new Map();
const allowlistConfigCache = new Map();
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

function bootstrapScenarioForRuntime(boName) {
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

function ensureAllowlistForBoName(boName) {
  if (!boName || !isAutoAllowlistEnabled()) {
    return { applied: false, reason: 'no-bo' };
  }

  const current = resolveAllowlistConfig(boName);
  if (current?.boName === boName) {
    return { applied: true, reason: 'already-bound', boName };
  }

  const bundled = getBundledAllowlist(boName);
  if (bundled) {
    applyAllowlistConfig(normalizeAllowlistConfig(bundled));
    return { applied: true, reason: 'bundled', boName: bundled.boName };
  }

  requestAllowlistFromBridge();
  return { applied: false, reason: 'no-bundled', boName };
}

function resolveAllowlistPathSet(boName) {
  const config = resolveAllowlistConfig(boName);
  return config ? allowlistCache.get(config.boName) : undefined;
}

function getAllowlistConfigForRuntime() {
  return resolveAllowlistConfig(getRuntimeMeta(runtimeContext).boName);
}

function applyAllowlistConfig(config) {
  const normalized = normalizeAllowlistConfig(config);
  if (!normalized?.boName) {
    return false;
  }
  allowlistConfigCache.set(normalized.boName, normalized);
  allowlistCache.set(normalized.boName, buildAllowlistPathSet(normalized));
  if (isConsoleOutputEnabled()) {
    scopeLog(`allowlist loaded: ${normalized.boName} v${normalized.version || '?'} (${normalized.fields?.length || 0} fields)`);
  }
  try {
    window.postMessage(
      {
        channel: 'StateScopeInternal',
        type: 'allowlistAck',
        boName: normalized.boName,
        version: normalized.version || ''
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
    return applyAllowlistConfig(JSON.parse(raw));
  } catch {
    return false;
  }
}

function bootstrapAllowlists() {
  if (!isAutoAllowlistEnabled()) {
    return { source: 'disabled', applied: false };
  }

  readAllowlistFromDom();
  drainPendingAllowlists();

  if (isBizDebugEnabled() && !runtimeContext.boName) {
    maybeDiscoverRuntimeTargets();
  }

  const boName = isBizDebugEnabled() ? getRuntimeMeta(runtimeContext).boName : '';
  if (boName) {
    const ensured = ensureAllowlistForBoName(boName);
    if (ensured.applied) {
      return { source: ensured.reason, applied: true, boName: ensured.boName || boName };
    }
  }

  // 禁止在未知 boName 时 fallback GoodsIssue（低代码页会被误绑）
  if (allowlistConfigCache.size > 0 && boName) {
    const current = resolveAllowlistConfig(boName);
    if (current?.boName === boName) {
      return { source: 'cache', applied: true, boName };
    }
  }

  return { source: 'none', applied: false, boName };
}

function requestAllowlistFromBridge() {
  if (!isAutoAllowlistEnabled()) {
    return;
  }
  try {
    window.postMessage({ channel: 'StateScopeInternal', type: 'requestAllowlist' }, window.location.origin);
  } catch {
    // ignore
  }
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
    if (applyAllowlistConfig(config)) {
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

  for (const key of [...allowlistCache.keys()]) {
    if (key !== newBo) {
      allowlistCache.delete(key);
      allowlistConfigCache.delete(key);
    }
  }

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
  runtimeContext.boName = meta.boName;

  if (prevBoName && meta.boName && prevBoName !== meta.boName) {
    handleBoSwitch(prevBoName, meta.boName);
  }

  if (meta.boName) {
    ensureAllowlistForBoName(meta.boName);
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
    version: '0.8.20',
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
    listLoadedAllowlists: () => [...allowlistConfigCache.keys()],
    applyAllowlistConfig(config) {
      return applyAllowlistConfig(config);
    },
    reloadAllowlist() {
      readAllowlistFromDom();
      drainPendingAllowlists();
      requestAllowlistFromBridge();
      const boot = bootstrapAllowlists();
      return {
        config: getAllowlistConfigForRuntime(),
        loadedKeys: [...allowlistConfigCache.keys()],
        boot
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
        ? { oldSide: 'visibleSnap (finalSnap)', newSide: 'shadowSnap', description: '可见态 vs 影子态' }
        : { oldSide: 'oldSnap', newSide: 'newSnap', description: '操作前 vs 操作后' }
    }),
    getProfileDetection: () => getProfileDetection(runtimeContext),
    getProfileMode: () => getForcedProfileMode(),
    setProfileMode(mode) {
      return setForcedProfileMode(mode);
    },
    getScenarioTag: () => getScenarioTag(),
    setScenarioTag: (tag) => setScenarioTag(tag),
    getScenarioCatalog: () => getScenarioCatalog(getRuntimeMeta(runtimeContext).boName),
    getScenarioCatalogPack: () => getScenarioCatalogPack(getRuntimeMeta(runtimeContext).boName),
    getScenarioCatalogSummary: () => getScenarioCatalogSummary(getRuntimeMeta(runtimeContext).boName),
    getScenarioDiagnostics: () => getScenarioDiagnostics(getRuntimeMeta(runtimeContext).boName),
    reconcileScenarioTag: () => reconcileScenarioTagForBo(getRuntimeMeta(runtimeContext).boName),
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
  requestAllowlistFromBridge();
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
      applyAllowlistConfig(event.data.config);
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
