import {
  getBundledScenarioPack,
  normalizeScenarioPack,
  resolveScenarioCatalog,
  summarizeScenarioPack
} from '../shared/scenario-catalog.js';
import { attachCatalogEpoch } from '../shared/scenario-catalog-epoch.js';
import { getBundledScenarioPackRaw } from './bundled-scenarios.js';

const LEGACY_TAG_KEY = 'stateScopeScenario';
const TAG_KEY_PREFIX = 'stateScopeScenario:';
const CATALOG_STORAGE_PREFIX = 'stateScopeScenarioCatalog:';

function catalogStorageKey(boName) {
  return `${CATALOG_STORAGE_PREFIX}${boName || 'default'}`;
}

function tagStorageKey(boName) {
  return `${TAG_KEY_PREFIX}${boName || 'default'}`;
}

/**
 * 当前场景 tag：按 BO 分片。
 * 旧扁平 key stateScopeScenario 会一次性迁移到 stateScopeScenario:{boName}。
 */
export function getScenarioTag(boName) {
  try {
    if (boName) {
      const keyed = localStorage.getItem(tagStorageKey(boName));
      if (keyed != null && keyed !== '') {
        return keyed;
      }
      const legacy = localStorage.getItem(LEGACY_TAG_KEY) || '';
      if (legacy) {
        localStorage.setItem(tagStorageKey(boName), legacy);
        localStorage.removeItem(LEGACY_TAG_KEY);
        return legacy;
      }
      return '';
    }
    return localStorage.getItem(LEGACY_TAG_KEY) || '';
  } catch {
    return '';
  }
}

export function setScenarioTag(tag, boName) {
  try {
    const key = boName ? tagStorageKey(boName) : LEGACY_TAG_KEY;
    if (!tag) {
      localStorage.removeItem(key);
      if (boName) {
        // 清掉可能残留的扁平旧 key，避免串单
        localStorage.removeItem(LEGACY_TAG_KEY);
      }
    } else {
      localStorage.setItem(key, tag);
      if (boName) {
        localStorage.removeItem(LEGACY_TAG_KEY);
      }
    }
    return getScenarioTag(boName);
  } catch {
    return '';
  }
}

/**
 * 保证当前 BO 有可用 scenarioTag（否则 Epoch 无 tag → 场景永远「未开始」）。
 * 优先沿用已选 tag；缺失时自动落到 catalog 第一项（通常 os-s01）。
 */
export function ensureActiveScenarioTag(boName) {
  const existing = getScenarioTag(boName);
  const pack = boName ? getScenarioCatalogPack(boName) : null;
  if (!pack?.scenarios?.length) {
    return existing || '';
  }
  if (existing && pack.scenarios.some((item) => item.tag === existing)) {
    return existing;
  }
  // 大小写/别名：OS-S01 → os-s01
  if (existing) {
    const lower = String(existing).trim().toLowerCase();
    const matched = pack.scenarios.find((item) => String(item.tag || '').toLowerCase() === lower);
    if (matched?.tag) {
      setScenarioTag(matched.tag, boName);
      return matched.tag;
    }
  }
  const firstTag = [...pack.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag;
  if (firstTag) {
    setScenarioTag(firstTag, boName);
    return firstTag;
  }
  return '';
}

const BO_SCENARIO_TAG_PREFIX = {
  OutsourceIssue: 'oi-',
  OutsourceStockin: 'os-',
  GoodsIssue: 'gi-'
};

/** 切换 BO 后清掉跨单据残留 tag（如 OutsourceStockin 页仍留 oi-s02） */
export function reconcileScenarioTagForBo(boName) {
  if (!boName) {
    return { cleared: false, tag: getScenarioTag(), reason: 'no-bo' };
  }

  const tag = getScenarioTag(boName);
  const pack = getScenarioCatalogPack(boName);
  const expectedPrefix = BO_SCENARIO_TAG_PREFIX[boName];

  if (tag && expectedPrefix && !tag.startsWith(expectedPrefix)) {
    setScenarioTag('', boName);
    const nextTag = pack?.scenarios?.length ?
        [...pack.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag
      : '';
    if (nextTag) {
      setScenarioTag(nextTag, boName);
    }
    return {
      cleared: true,
      previousTag: tag,
      tag: getScenarioTag(boName),
      reason: `tag prefix mismatch for ${boName}`
    };
  }

  if (tag && pack?.scenarios?.length && !pack.scenarios.some((item) => item.tag === tag)) {
    const nextTag = [...pack.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag;
    setScenarioTag(nextTag || '', boName);
    return {
      cleared: true,
      previousTag: tag,
      tag: getScenarioTag(boName),
      reason: 'tag not in catalog'
    };
  }

  if (!tag && pack?.scenarios?.length) {
    const nextTag = [...pack.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag;
    if (nextTag) {
      setScenarioTag(nextTag, boName);
      return { cleared: false, tag: nextTag, reason: 'auto-set-first-scenario' };
    }
  }

  // 别名兜底：用户/`localStorage` 里若是 OS-S01，归一到 catalog 的 os-s01
  if (tag && pack?.scenarios?.length) {
    const lower = String(tag).trim().toLowerCase();
    const matched = pack.scenarios.find((item) => String(item.tag || '').toLowerCase() === lower);
    if (matched?.tag && matched.tag !== tag) {
      setScenarioTag(matched.tag, boName);
      return {
        cleared: true,
        previousTag: tag,
        tag: matched.tag,
        reason: 'tag-case-normalized'
      };
    }
  }

  return { cleared: false, tag, reason: tag ? 'ok' : 'no-tag' };
}

export function getScenarioDiagnostics(boName) {
  const pack = getScenarioCatalogPack(boName);
  return {
    boName: boName || '',
    scenarioTag: getScenarioTag(boName),
    catalogLoaded: !!pack?.scenarios?.length,
    catalogSummary: summarizeScenarioPack(pack),
    catalogStorageKey: catalogStorageKey(boName),
    catalogEpoch: pack?.catalogEpoch || '',
    catalogSource: pack?.source || '',
    reconcile: reconcileScenarioTagForBo(boName)
  };
}

function readScenarioCatalogFromDom() {
  try {
    const raw = document.documentElement.getAttribute('data-state-scope-scenario-catalog');
    if (!raw) {
      return null;
    }
    return normalizeScenarioPack(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function bootstrapScenarioCatalogFromDom(boName) {
  const fromDom = readScenarioCatalogFromDom();
  if (!fromDom?.scenarios?.length) {
    return null;
  }
  if (boName && fromDom.boName && fromDom.boName !== boName) {
    return null;
  }
  return applyScenarioCatalog(fromDom, boName || fromDom.boName) ? fromDom : null;
}

function readCatalogFromLocalStorage(boName) {
  try {
    const key = catalogStorageKey(boName);
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return normalizeScenarioPack(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * 页面权威包：① window-registry > ② localStorage > DOM > bundled(GoodsIssue)。
 * ① 一次出现：无条件覆盖 ②（即使 catalogEpoch 相同）。
 */
export function resolvePageScenarioPack(boName) {
  if (!boName) {
    // 无 boName 时勿硬返回空：否则 Panel restore/summary 误判页面无包，每轮 re-apply 卡死刷新
    try {
      const fromDom = readScenarioCatalogFromDom();
      if (fromDom?.boName) {
        return resolvePageScenarioPack(fromDom.boName);
      }
      const reg = typeof window !== 'undefined' ? window.__STATE_SCOPE_SCENARIOS__ : null;
      const keys = reg && typeof reg === 'object' ? Object.keys(reg).filter((k) => reg[k]?.scenarios?.length) : [];
      if (keys.length === 1) {
        return resolvePageScenarioPack(keys[0]);
      }
    } catch {
      // fall through
    }
    return { pack: null, source: '' };
  }

  try {
    const reg = typeof window !== 'undefined' ? window.__STATE_SCOPE_SCENARIOS__ : null;
    const fromReg = reg?.[boName];
    if (fromReg?.scenarios?.length) {
      // 勿在 normalize 前写 source=window-registry：会误走「已归一化/有 tag」分支
      const normalized = normalizeScenarioPack({
        ...fromReg,
        boName: fromReg.boName || boName,
        source: undefined
      });
      if (normalized) {
        const pack = attachCatalogEpoch(normalized, 'window-registry');
        try {
          localStorage.setItem(catalogStorageKey(boName), JSON.stringify(pack));
        } catch {
          // ignore quota
        }
        return { pack, source: 'window-registry' };
      }
      return { pack: null, source: 'window-registry', error: 'normalize-failed' };
    }
  } catch {
    // fall through
  }

  const fromLs = readCatalogFromLocalStorage(boName);
  if (fromLs?.scenarios?.length) {
    const pack =
      fromLs.source === 'window-registry'
        ? normalizeScenarioPack({ ...fromLs, source: 'local-upload' }) || fromLs
        : fromLs;
    return { pack, source: pack.source || 'local-upload' };
  }

  const fromDom = readScenarioCatalogFromDom();
  if (fromDom?.scenarios?.length && (!fromDom.boName || fromDom.boName === boName)) {
    return { pack: fromDom, source: fromDom.source || 'dom' };
  }

  const bundled = getBundledScenarioPack(boName);
  if (bundled) {
    return { pack: bundled, source: bundled.source || 'tool-l3' };
  }

  return { pack: null, source: '' };
}

/** 仅读用户上传/已缓存的 catalog；无则 null（不 fallback 内置假清单） */
export function getScenarioCatalogPack(boName) {
  return resolvePageScenarioPack(boName).pack;
}

export function applyScenarioCatalog(config, boName) {
  const normalized = normalizeScenarioPack(config);
  if (!normalized) {
    return false;
  }
  const targetBo = boName || normalized.boName;
  if (!targetBo) {
    return false;
  }
  try {
    localStorage.setItem(catalogStorageKey(targetBo), JSON.stringify(normalized));
    if (!getScenarioTag(targetBo)) {
      const firstTag = [...normalized.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag;
      if (firstTag) {
        setScenarioTag(firstTag, targetBo);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function clearScenarioCatalog(boName) {
  try {
    if (boName) {
      localStorage.removeItem(catalogStorageKey(boName));
    } else {
      Object.keys(localStorage)
        .filter((key) => key.startsWith(CATALOG_STORAGE_PREFIX))
        .forEach((key) => localStorage.removeItem(key));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 仅对有 bundled 的 BO（GoodsIssue）自动装包。
 * OutsourceIssue 等返回 null → Panel 强制上传领域 SSOT。
 */
export function bootstrapScenarioCatalog(boName) {
  const bundled = getBundledScenarioPackRaw(boName);
  if (!bundled) {
    return null;
  }
  const resolved = resolvePageScenarioPack(boName);
  // 已有 ① 时不要用内置包压过领域
  if (resolved.source === 'window-registry' && resolved.pack) {
    return resolved.pack;
  }
  if (resolved.pack?.catalogEpoch && resolved.pack.version === bundled.version) {
    return resolved.pack;
  }
  applyScenarioCatalog(bundled, boName);
  return normalizeScenarioPack(bundled);
}

export function getScenarioCatalog(boName) {
  const pack = getScenarioCatalogPack(boName);
  if (pack?.scenarios?.length) {
    return pack.scenarios;
  }
  return [];
}

export function getScenarioCatalogSummary(boName) {
  const pack = getScenarioCatalogPack(boName);
  return summarizeScenarioPack(pack);
}

export function getActiveScenarioCatalogList(boName) {
  return resolveScenarioCatalog(getScenarioCatalogPack(boName) || boName);
}
