const hooks = new Map();
const STALE_THRESHOLD_MS = 30000;

/**
 * @param {{ name: string, target: object, methodName: string, original: Function,
 *           wrapped: Function, onUnwrap?: Function, resolveCurrent?: Function }} opts
 */
export function registerHook({ name, target, methodName, original, wrapped, onUnwrap, resolveCurrent }) {
  hooks.set(name, {
    name,
    target,
    methodName,
    original,
    wrapped,
    onUnwrap: onUnwrap || null,
    resolveCurrent: resolveCurrent || null,
    originalFingerprint: `${original.name || ''}:${original.toString().length}`,
    installedAt: Date.now(),
    lastTriggeredAt: 0,
    triggerCount: 0
  });
  scheduleStaleWarning(name);
}

export function markTriggered(name) {
  const hook = hooks.get(name);
  if (hook) {
    hook.lastTriggeredAt = Date.now();
    hook.triggerCount += 1;
  }
}

export function getHookLiveness(staleThresholdMs = STALE_THRESHOLD_MS) {
  const result = {};
  for (const [name, hook] of hooks) {
    const age = Date.now() - hook.installedAt;
    result[name] = {
      installedAt: hook.installedAt,
      lastTriggeredAt: hook.lastTriggeredAt,
      triggerCount: hook.triggerCount,
      alive: hook.triggerCount > 0 || age < staleThresholdMs,
      stale: age > staleThresholdMs && hook.triggerCount === 0
    };
  }
  return result;
}

export function unwrapHook(name) {
  const hook = hooks.get(name);
  if (!hook) return false;
  try {
    if (typeof hook.onUnwrap === 'function') {
      hook.onUnwrap();
    } else {
      hook.target[hook.methodName] = hook.original;
    }
    hooks.delete(name);
    return true;
  } catch {
    return false;
  }
}

export function unwrapAll() {
  const results = {};
  for (const name of [...hooks.keys()]) {
    results[name] = unwrapHook(name);
  }
  return results;
}

export function verifyHookIntegrity() {
  const result = {};
  for (const [name, hook] of hooks) {
    let current;
    try {
      current =
        typeof hook.resolveCurrent === 'function'
          ? hook.resolveCurrent()
          : hook.target[hook.methodName];
    } catch {
      current = undefined;
    }
    result[name] = {
      isOurWrapper: current === hook.wrapped,
      overridden: current !== hook.wrapped && current !== hook.original
    };
  }
  return result;
}

export function getRegisteredHookCount() {
  return hooks.size;
}

export function clearRegistry() {
  hooks.clear();
}

function scheduleStaleWarning(name) {
  setTimeout(() => {
    const hook = hooks.get(name);
    if (hook && hook.triggerCount === 0) {
      const age = Math.round((Date.now() - hook.installedAt) / 1000);
      console.warn(
        `[StateScope] hook "${name}" installed ${age}s ago but never triggered — target method may have been renamed or removed`
      );
    }
  }, STALE_THRESHOLD_MS + 500);
}
