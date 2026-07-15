/**
 * 从页面 webpack 模块图中按 *.allowlist* 约定检索领域 SSOT。
 * boName 由调用方传入（工具已有解析），此处不做 boName 发现。
 *
 * DevTools Sources 的 webpack:// 来自 source map。
 * 当 __webpack_require__ 捕获失败时，直接从 webpackChunk 内 module factory 源码提取对象字面量。
 */

import { parseAllowlistObjectFromSource } from '../shared/parse-allowlist-ts.js';

let cachedWebpackRequires = null;
let captureInstalled = false;
/** @type {Map<string, { factory: Function, chunkKey: string }>} */
const factoryRegistry = new Map();

const ALLOWLIST_ID_RE = /allowlist/i;
/** 约定：*.allowlist.ts（亦可识别历史 *.js） */
const ALLOWLIST_FILE_RE = /[\w./-]*allowlist[\w.-]*\.(?:ts|js)/i;

function chunkPriority(key) {
  const k = String(key || '');
  if (/biz_app_service_scm/i.test(k)) {
    return 0;
  }
  if (/biz_app_service/i.test(k)) {
    return 1;
  }
  return 2;
}

function indexFactoriesFromEntry(entry, chunkKey) {
  if (!Array.isArray(entry)) {
    return 0;
  }
  const modules = entry[1];
  if (!modules || typeof modules !== 'object') {
    return 0;
  }
  let n = 0;
  for (const id of Object.keys(modules)) {
    const factory = modules[id];
    if (typeof factory !== 'function') {
      continue;
    }
    factoryRegistry.set(`${chunkKey}::${id}`, { factory, chunkKey, id: String(id) });
    n += 1;
    // 顺手包一层，下次执行任意模块时偷到 __webpack_require__
    if (!factory.__stateScopeRequireWrapped) {
      const original = factory;
      const wrapped = function stateScopeFactoryWrapper(module, exports, __webpack_require__) {
        rememberRequire(__webpack_require__);
        return original.apply(this, arguments);
      };
      wrapped.__stateScopeRequireWrapped = true;
      try {
        modules[id] = wrapped;
        factoryRegistry.set(`${chunkKey}::${id}`, { factory: wrapped, chunkKey, id: String(id) });
      } catch {
        factoryRegistry.set(`${chunkKey}::${id}`, { factory: original, chunkKey, id: String(id) });
      }
    }
  }
  return n;
}

function foldToken(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function boNameVariants(boName) {
  const raw = String(boName || '').trim();
  if (!raw) {
    return [];
  }
  const lowerFirst = raw.charAt(0).toLowerCase() + raw.slice(1);
  const upperFirst = raw.charAt(0).toUpperCase() + raw.slice(1);
  return [...new Set([raw, lowerFirst, upperFirst, foldToken(raw)].filter(Boolean))];
}

function isDirectAllowlistConfig(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.boName === 'string' &&
    Array.isArray(value.fields) &&
    value.fields.length > 0
  );
}

export function isAllowlistConfigShape(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (
    isDirectAllowlistConfig(value) ||
    isDirectAllowlistConfig(value.default) ||
    isDirectAllowlistConfig(value.allowlist) ||
    isDirectAllowlistConfig(value.default?.allowlist)
  );
}

export function unwrapAllowlistExports(modOrExports) {
  if (!modOrExports) {
    return null;
  }
  const exports = modOrExports.exports !== undefined ? modOrExports.exports : modOrExports;
  if (!exports || typeof exports !== 'object') {
    return null;
  }
  if (isDirectAllowlistConfig(exports)) {
    return exports;
  }
  if (isDirectAllowlistConfig(exports.allowlist)) {
    return exports.allowlist;
  }
  if (isDirectAllowlistConfig(exports.default)) {
    return exports.default;
  }
  if (isDirectAllowlistConfig(exports.default?.allowlist)) {
    return exports.default.allowlist;
  }
  return null;
}

export function moduleIdMatchesBoAllowlist(moduleId, boName) {
  const id = String(moduleId || '');
  if (!ALLOWLIST_ID_RE.test(id)) {
    return false;
  }
  const foldedId = foldToken(id);
  return boNameVariants(boName).some((variant) => foldedId.includes(foldToken(variant)));
}

function sourceTextMatchesBoAllowlist(sourceText, boName) {
  if (!sourceText || !ALLOWLIST_ID_RE.test(sourceText)) {
    return false;
  }
  const folded = foldToken(sourceText);
  return boNameVariants(boName).some((variant) => folded.includes(foldToken(variant)));
}

function matchesBoName(config, boName) {
  if (!config?.boName || !boName) {
    return false;
  }
  return foldToken(config.boName) === foldToken(boName);
}

function isWebpackRequire(fn) {
  return typeof fn === 'function' && fn.c && typeof fn.c === 'object';
}

/** top + 同源 iframe（领域包常在子 frame） */
function collectSearchWindows() {
  const list = [window];
  try {
    for (let i = 0; i < window.frames.length; i += 1) {
      try {
        const frame = window.frames[i];
        if (frame && frame !== window) {
          // 触达同源属性；跨域会抛错
          void frame.location?.href;
          list.push(frame);
        }
      } catch {
        // cross-origin
      }
    }
  } catch {
    // ignore
  }
  return list;
}

function collectWebpackChunkEntries() {
  const entries = [];
  for (const win of collectSearchWindows()) {
    try {
      for (const key of Object.keys(win)) {
        if (!/^webpackChunk/i.test(key)) {
          continue;
        }
        const chunkArray = win[key];
        if (Array.isArray(chunkArray)) {
          entries.push({ win, key, chunkArray });
        }
      }
    } catch {
      // ignore
    }
  }
  entries.sort((a, b) => chunkPriority(a.key) - chunkPriority(b.key));
  return entries;
}

function rememberRequire(requireFn) {
  if (!isWebpackRequire(requireFn)) {
    return;
  }
  if (!cachedWebpackRequires) {
    cachedWebpackRequires = new Set();
  }
  cachedWebpackRequires.add(requireFn);
}

function captureRequireFromChunkPush(chunkArray, chunkKey) {
  if (!chunkArray || chunkArray.__stateScopeAllowlistHooked) {
    return;
  }
  chunkArray.__stateScopeAllowlistHooked = true;

  // 索引历史条目（单据包可能早已 push 完）
  for (const entry of chunkArray) {
    indexFactoriesFromEntry(entry, chunkKey || 'unknown');
  }

  const originalPush = chunkArray.push.bind(chunkArray);
  chunkArray.push = function stateScopeAllowlistPush(...args) {
    for (const entry of args) {
      indexFactoriesFromEntry(entry, chunkKey || 'unknown');
      if (Array.isArray(entry) && typeof entry[2] === 'function') {
        try {
          const runtime = entry[2];
          entry[2] = function stateScopeWrappedRuntime(__webpack_require__, ...rest) {
            rememberRequire(__webpack_require__);
            return runtime.call(this, __webpack_require__, ...rest);
          };
        } catch {
          // ignore
        }
      }
    }
    return originalPush(...args);
  };
}

/**
 * webpack 5：chunk 第三段 runtime(fn) 会收到 __webpack_require__。
 * 仅 push 一个 modules factory 不会执行，旧探针永远抓不到 require。
 */
function injectCaptureRuntimeIntoChunk(chunkArray, chunkKey) {
  if (!Array.isArray(chunkArray)) {
    return false;
  }
  const probeId = `__StateScopeAllowlistCaptureRuntime__${chunkKey}`;
  if (chunkArray.__stateScopeProbeIds?.has(probeId)) {
    return false;
  }
  if (!chunkArray.__stateScopeProbeIds) {
    chunkArray.__stateScopeProbeIds = new Set();
  }
  chunkArray.__stateScopeProbeIds.add(probeId);

  try {
    chunkArray.push([
      [probeId],
      {},
      function stateScopeAllowlistRuntime(__webpack_require__) {
        rememberRequire(__webpack_require__);
      }
    ]);
    return true;
  } catch {
    return false;
  }
}

function installWebpackRequireCapture() {
  if (captureInstalled) {
    for (const { key, chunkArray } of collectWebpackChunkEntries()) {
      captureRequireFromChunkPush(chunkArray, key);
      injectCaptureRuntimeIntoChunk(chunkArray, key);
    }
    return;
  }
  captureInstalled = true;

  for (const { key, chunkArray } of collectWebpackChunkEntries()) {
    captureRequireFromChunkPush(chunkArray, key);
    injectCaptureRuntimeIntoChunk(chunkArray, key);
  }

  let polls = 0;
  const timer = setInterval(() => {
    polls += 1;
    for (const { key, chunkArray } of collectWebpackChunkEntries()) {
      captureRequireFromChunkPush(chunkArray, key);
      injectCaptureRuntimeIntoChunk(chunkArray, key);
    }
    if (polls >= 40 || (cachedWebpackRequires && cachedWebpackRequires.size > 0)) {
      clearInterval(timer);
    }
  }, 400);
}

function getWebpackRequires() {
  installWebpackRequireCapture();
  if (cachedWebpackRequires?.size) {
    return [...cachedWebpackRequires];
  }
  for (const { key, chunkArray } of collectWebpackChunkEntries()) {
    injectCaptureRuntimeIntoChunk(chunkArray, key);
  }
  return cachedWebpackRequires ? [...cachedWebpackRequires] : [];
}

function tryReadConfigFromCachedModule(mod, boName) {
  const config = unwrapAllowlistExports(mod);
  if (config && matchesBoName(config, boName)) {
    return config;
  }
  return null;
}

function scanOneRequire(requireFn, boName) {
  if (!isWebpackRequire(requireFn)) {
    return null;
  }

  const cache = requireFn.c || {};
  for (const id of Object.keys(cache)) {
    try {
      const config = tryReadConfigFromCachedModule(cache[id], boName);
      if (config) {
        return {
          config,
          moduleId: id,
          sourceHint: inferSourceHint(id, config)
        };
      }
    } catch {
      // ignore
    }
  }

  const factories = requireFn.m || {};
  for (const id of Object.keys(factories)) {
    const idMatch = moduleIdMatchesBoAllowlist(id, boName);
    let textMatch = false;
    try {
      textMatch = sourceTextMatchesBoAllowlist(String(factories[id]), boName);
    } catch {
      textMatch = false;
    }
    if (!idMatch && !textMatch) {
      continue;
    }
    try {
      const exported = requireFn(id);
      const config = unwrapAllowlistExports(exported) || unwrapAllowlistExports({ exports: exported });
      if (config && matchesBoName(config, boName)) {
        return {
          config,
          moduleId: id,
          sourceHint: inferSourceHint(id, config)
        };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function inferSourceHint(moduleId, config) {
  const id = String(moduleId || '');
  const fileMatch = id.match(ALLOWLIST_FILE_RE);
  if (fileMatch) {
    return fileMatch[0].split('/').pop() || fileMatch[0];
  }
  if (/allowlist/i.test(id)) {
    const leaf = id.split('/').pop();
    if (leaf) {
      return leaf;
    }
  }
  if (config?.boName) {
    const local = config.boName.charAt(0).toLowerCase() + config.boName.slice(1);
    return `${local}.allowlist.ts`;
  }
  return 'allowlist.ts';
}

/**
 * 不依赖 __webpack_require__：遍历 factoryRegistry + webpackChunk factories，
 * 从 toString() 源码中抠出 allowlist 对象。
 */
function tryParseFactory(factory, id, chunkKey, boName, stats) {
  if (typeof factory !== 'function') {
    return null;
  }
  stats.inspected += 1;
  let src = '';
  try {
    src = Function.prototype.toString.call(factory);
  } catch {
    return null;
  }
  if (!ALLOWLIST_ID_RE.test(src) && !/allowlist/i.test(String(id))) {
    return null;
  }
  stats.allowlistMention += 1;
  if (boName && !sourceTextMatchesBoAllowlist(src, boName) && !moduleIdMatchesBoAllowlist(id, boName)) {
    if (!new RegExp(boName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(src)) {
      return null;
    }
  }
  const parsed = parseAllowlistObjectFromSource(src);
  if (!parsed.ok || !parsed.config) {
    return null;
  }
  if (!matchesBoName(parsed.config, boName)) {
    return null;
  }
  return {
    config: parsed.config,
    moduleId: id,
    sourceHint: inferSourceHint(id, parsed.config),
    via: 'chunk-factory-source',
    chunkKey,
    inspected: stats.inspected,
    allowlistMention: stats.allowlistMention
  };
}

function scanChunkFactoriesBySource(boName) {
  const stats = { inspected: 0, allowlistMention: 0 };

  // 确保最新 push 已入索引
  for (const { key, chunkArray } of collectWebpackChunkEntries()) {
    if (!chunkArray.__stateScopeAllowlistHooked) {
      captureRequireFromChunkPush(chunkArray, key);
    } else {
      for (const entry of chunkArray) {
        indexFactoriesFromEntry(entry, key);
      }
    }
  }

  const registryEntries = [...factoryRegistry.entries()].sort((a, b) => {
    return chunkPriority(a[1].chunkKey) - chunkPriority(b[1].chunkKey);
  });

  for (const [, item] of registryEntries) {
    const hit = tryParseFactory(item.factory, item.id, item.chunkKey, boName, stats);
    if (hit) {
      return hit;
    }
  }

  for (const { key, chunkArray } of collectWebpackChunkEntries()) {
    if (!Array.isArray(chunkArray)) {
      continue;
    }
    for (const entry of chunkArray) {
      if (!Array.isArray(entry)) {
        continue;
      }
      const modules = entry[1];
      if (!modules || typeof modules !== 'object') {
        continue;
      }
      for (const id of Object.keys(modules)) {
        const hit = tryParseFactory(modules[id], id, key, boName, stats);
        if (hit) {
          return hit;
        }
      }
    }
  }
  return {
    miss: true,
    inspected: stats.inspected,
    allowlistMention: stats.allowlistMention,
    registrySize: factoryRegistry.size
  };
}

/**
 * @param {string} boName 工具已解析的单据 boName
 * @returns {{ config: object, moduleId: string, source: string, sourceHint: string } | null}
 */
export function scanAllowlistByBoName(boName) {
  if (!boName) {
    return null;
  }

  const requires = getWebpackRequires();
  for (const requireFn of requires) {
    const hit = scanOneRequire(requireFn, boName);
    if (hit?.config) {
      return {
        config: hit.config,
        moduleId: hit.moduleId,
        source: 'webpack-source',
        sourceHint: hit.sourceHint
      };
    }
  }

  // require 捕获失败时的主路径：直接读 chunk factory 源码
  const fromFactory = scanChunkFactoriesBySource(boName);
  if (fromFactory?.config) {
    return {
      config: fromFactory.config,
      moduleId: fromFactory.moduleId,
      source: 'webpack-source',
      sourceHint: fromFactory.sourceHint
    };
  }

  return null;
}

/** 诊断：Sources 能看到 webpack:// 不等于扫描器已抓住 require */
export function diagnoseAllowlistScan(boName) {
  installWebpackRequireCapture();
  const chunks = collectWebpackChunkEntries().map(({ key }) => key);
  const requires = getWebpackRequires();
  const requireStats = requires.map((requireFn, index) => {
    const cacheIds = Object.keys(requireFn.c || {});
    const factoryIds = Object.keys(requireFn.m || {});
    let allowlistLike = 0;
    let boMatch = 0;
    for (const id of cacheIds) {
      try {
        const config = unwrapAllowlistExports(requireFn.c[id]);
        if (config) {
          allowlistLike += 1;
          if (boName && matchesBoName(config, boName)) {
            boMatch += 1;
          }
        }
      } catch {
        // ignore
      }
    }
    return {
      index,
      cacheSize: cacheIds.length,
      factorySize: factoryIds.length,
      allowlistLikeInCache: allowlistLike,
      boMatchInCache: boMatch,
      sampleAllowlistIds: cacheIds.filter((id) => /allowlist/i.test(String(id))).slice(0, 8)
    };
  });

  const factoryScan = boName ? scanChunkFactoriesBySource(boName) : { miss: true };
  const hit = boName ? scanAllowlistByBoName(boName) : null;

  let hint = '未知';
  if (hit) {
    hint = '已命中';
  } else if (requires.length === 0 && factoryScan?.miss) {
    hint = `未捕获 require；chunk factory 扫描 inspected=${factoryScan.inspected || 0} allowlistMention=${factoryScan.allowlistMention || 0}（单据包可能未进当前 webpackChunk，或 factory 源码已被压缩到无法抠字面量）`;
  } else if (requires.length === 0) {
    hint = '未捕获 __webpack_require__，但 factory 源码路径可试';
  } else {
    hint = '已捕获 require 但未匹配 exports.allowlist';
  }

  return {
    chunkKeys: chunks,
    requireCount: requires.length,
    requireStats,
    factoryScan: factoryScan?.miss ?
        {
          miss: true,
          inspected: factoryScan.inspected,
          allowlistMention: factoryScan.allowlistMention,
          registrySize: factoryScan.registrySize
        }
      : {
          miss: false,
          moduleId: factoryScan.moduleId,
          sourceHint: factoryScan.sourceHint,
          via: factoryScan.via,
          chunkKey: factoryScan.chunkKey
        },
    hit: hit ?
        {
          moduleId: hit.moduleId,
          sourceHint: hit.sourceHint,
          boName: hit.config?.boName,
          fieldCount: hit.config?.fields?.length
        }
      : null,
    hint
  };
}

/** 测试 / 调试：重置捕获状态 */
export function resetAllowlistModuleCaptureForTests() {
  cachedWebpackRequires = null;
  captureInstalled = false;
  factoryRegistry.clear();
}
