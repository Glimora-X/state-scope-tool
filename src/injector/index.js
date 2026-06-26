import {
  LOG_PREFIX,
  canActivate,
  getActivationDiagnostics,
  isBizDebugEnabled,
  isRuntimeReady,
  warnIfNonLocalhostActive
} from './activate.js';
import { detectProfile, getRuntimeMeta } from './detect.js';
import { createEpochManager, reportEpochToConsole } from './console-reporter.js';
import {
  discoverRuntimeTargets,
  isWrapped
} from './discover.js';
import { wrapDispatchAction, wrapComputeInitialStates } from './wrap-new.js';
import { wrapUiStateController } from './wrap-old.js';
import { wrapGetDisable } from './wrap-lowcode.js';
import { wrapFormController } from './wrap-consume.js';
import { installDebugApi } from './debug-store.js';
import { scopeLog } from './safe-log.js';
import { buildAllowlistPathSet } from './allowlist-config.js';
import { getScenarioCatalog, getScenarioTag, setScenarioTag } from './scenario-context.js';
import { buildRuntimePayload } from './panel-payload.js';
import { getPanelSyncPayload, publishRuntimeToPanel, republishCachedPanelState } from './panel-post.js';

const allowlistCache = new Map();
const allowlistConfigCache = new Map();
let epochManager = null;
let runtimeContext = {};
let installed = false;

console.info(`${LOG_PREFIX} injector loaded (P0.6 panel). Set localStorage.bizDebug='true' and refresh.`);

function getAllowlistPathSet(boName) {
  if (!boName) {
    return undefined;
  }
  return allowlistCache.get(boName);
}

function getAllowlistConfig(boName) {
  if (!boName) {
    return undefined;
  }
  return allowlistConfigCache.get(boName);
}

function applyAllowlistConfig(config) {
  if (!config?.boName) {
    return false;
  }
  allowlistConfigCache.set(config.boName, config);
  allowlistCache.set(config.boName, buildAllowlistPathSet(config));
  scopeLog(`${LOG_PREFIX} allowlist loaded: ${config.boName} v${config.version || '?'} (${config.fields?.length || 0} fields)`);
  return true;
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
    return epochManager;
  }

  epochManager = createEpochManager((epoch) => {
    reportEpochToConsole(
      epoch,
      getRuntimeMeta(runtimeContext),
      getAllowlistConfig(getRuntimeMeta(runtimeContext).boName)
    );
    publishRuntimeToPanel(buildRuntimePayload(runtimeContext));
  });

  return epochManager;
}

function refreshRuntimeTargets() {
  runtimeContext = {
    ...runtimeContext,
    ...discoverRuntimeTargets()
  };
  runtimeContext.profile = detectProfile(runtimeContext);
  return runtimeContext;
}

function installHooks() {
  const manager = ensureEpochManager();
  const profile = runtimeContext.profile;
  let hookCount = 0;

  if (runtimeContext.bizApplication?.stateManager && !isWrapped(runtimeContext.bizApplication)) {
    wrapDispatchAction(runtimeContext.bizApplication, manager);
    wrapComputeInitialStates(runtimeContext.bizApplication.stateManager, manager);
    hookCount += 1;
  }

  if (profile !== 'lowcode') {
    if (runtimeContext.formController && !isWrapped(runtimeContext.formController)) {
      wrapFormController(runtimeContext.formController, manager);
      hookCount += 1;
    } else if (runtimeContext.uiStateController && !isWrapped(runtimeContext.uiStateController)) {
      wrapUiStateController(runtimeContext.uiStateController, manager, runtimeContext.presenter);
      hookCount += 1;
    }
  }

  if (profile === 'lowcode' && runtimeContext.viewModel && !isWrapped(runtimeContext.viewModel)) {
    if (wrapGetDisable(runtimeContext.viewModel, manager)) {
      hookCount += 1;
    }
  }

  return hookCount;
}

function markInstalled() {
  const meta = getRuntimeMeta(runtimeContext);

  window.__StateScope__ = {
    installed: true,
    version: '0.5.2',
    mode: 'P1.5-scenario',
    getMeta: () => getRuntimeMeta(runtimeContext),
    getDiagnostics: () => getActivationDiagnostics(runtimeContext),
    rediscover: () => {
      refreshRuntimeTargets();
      installHooks();
      return getRuntimeMeta(runtimeContext);
    },
    getAllowlist: () => getAllowlistPathSet(meta.boName),
    getAllowlistConfig: () => getAllowlistConfig(meta.boName),
    applyAllowlistConfig(config) {
      return applyAllowlistConfig(config);
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
    getScenarioTag: () => getScenarioTag(),
    setScenarioTag: (tag) => setScenarioTag(tag),
    getScenarioCatalog: () => getScenarioCatalog(),
    setAllowlist(boName, paths) {
      allowlistCache.set(boName, new Set(Array.isArray(paths) ? paths : []));
    },
    forceFinalize: () => ensureEpochManager().finalizeEpoch(),
    getPanelSyncPayload: () => getPanelSyncPayload(),
    syncPanelState: () => republishCachedPanelState(),
    extensionRelayBroken: false
  };

  installDebugApi(window, scopeLog);
  publishRuntimeToPanel(buildRuntimePayload(runtimeContext));

  console.info(
    `${LOG_PREFIX} active | boName=${meta.boName || '(unknown)'} | profile=${meta.profile} | route=${meta.route}`
  );
  console.info(`${LOG_PREFIX} hooks:`, {
    bizApplication: !!runtimeContext.bizApplication?.stateManager,
    presenter: !!runtimeContext.presenter,
    uiStateController: !!runtimeContext.uiStateController,
    formController: !!runtimeContext.formController,
    lowcodeViewModel: !!runtimeContext.viewModel
  });
}

function activateIfReady() {
  refreshRuntimeTargets();

  if (!isBizDebugEnabled()) {
    return 'no-debug';
  }

  if (!canActivate(runtimeContext)) {
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

  return 'ready';
}

function logWaitingReason(attempts) {
  const diag = getActivationDiagnostics(refreshRuntimeTargets());

  if (!diag.bizDebug) {
    console.warn(
      `${LOG_PREFIX} waiting: localStorage.bizDebug is not 'true'. Run localStorage.setItem('bizDebug','true') then refresh.`
    );
    return;
  }

  if (attempts === 1) {
    console.info(`${LOG_PREFIX} bizDebug ok, scanning page for voucher presenter...`);
  }

  if (attempts % 10 === 0) {
    console.warn(`${LOG_PREFIX} still waiting (${attempts}/240):`, diag);
    console.warn(
      `${LOG_PREFIX} tips: traditional voucher needs presenter/formController; lowcode needs MDF viewModel with gridModel.bo`
    );
  }
}

function startPolling() {
  let attempts = 0;
  const maxAttempts = 240;

  const timer = setInterval(() => {
    attempts += 1;
    const status = activateIfReady();

    if (status === 'no-debug' || status === 'waiting-targets') {
      logWaitingReason(attempts);
    }

    if (status === 'ready') {
      const captureReady =
        (runtimeContext.profile === 'traditional' &&
          (runtimeContext.formController || runtimeContext.uiStateController)) ||
        (runtimeContext.profile === 'lowcode' && runtimeContext.viewModel) ||
        runtimeContext.bizApplication?.stateManager;

      if (captureReady) {
        clearInterval(timer);
        return;
      }
    }

    if (attempts >= maxAttempts) {
      if (status !== 'ready') {
        console.error(`${LOG_PREFIX} gave up after ${maxAttempts} attempts.`, getActivationDiagnostics(runtimeContext));
      } else {
        console.warn(`${LOG_PREFIX} active but formController not found; field ops may have limited capture.`);
      }
      clearInterval(timer);
    }
  }, 500);
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
    } else {
      window.__StateScope__.extensionRelayBroken = false;
      window.__StateScope__.extensionRelayError = '';
    }
  }
});

startPolling();
