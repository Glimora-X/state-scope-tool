import {
  getBundledScenarioPack,
  normalizeScenarioPack,
  resolveScenarioCatalog,
  summarizeScenarioPack
} from '../shared/scenario-catalog.js';
import { getBundledScenarioPackRaw } from './bundled-scenarios.js';

const STORAGE_KEY = 'stateScopeScenario';
const CATALOG_STORAGE_PREFIX = 'stateScopeScenarioCatalog:';

export function getScenarioTag() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setScenarioTag(tag) {
  try {
    if (!tag) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, tag);
    }
    return getScenarioTag();
  } catch {
    return '';
  }
}

function catalogStorageKey(boName) {
  return `${CATALOG_STORAGE_PREFIX}${boName || 'default'}`;
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

  const tag = getScenarioTag();
  const pack = getScenarioCatalogPack(boName);
  const expectedPrefix = BO_SCENARIO_TAG_PREFIX[boName];

  if (tag && expectedPrefix && !tag.startsWith(expectedPrefix)) {
    setScenarioTag('');
    const nextTag = pack?.scenarios?.length ?
        [...pack.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag
      : '';
    if (nextTag) {
      setScenarioTag(nextTag);
    }
    return {
      cleared: true,
      previousTag: tag,
      tag: getScenarioTag(),
      reason: `tag prefix mismatch for ${boName}`
    };
  }

  if (tag && pack?.scenarios?.length && !pack.scenarios.some((item) => item.tag === tag)) {
    const nextTag = [...pack.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag;
    setScenarioTag(nextTag || '');
    return {
      cleared: true,
      previousTag: tag,
      tag: getScenarioTag(),
      reason: 'tag not in catalog'
    };
  }

  if (!tag && pack?.scenarios?.length) {
    const nextTag = [...pack.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag;
    if (nextTag) {
      setScenarioTag(nextTag);
      return { cleared: false, tag: nextTag, reason: 'auto-set-first-scenario' };
    }
  }

  return { cleared: false, tag, reason: tag ? 'ok' : 'no-tag' };
}

export function getScenarioDiagnostics(boName) {
  const pack = getScenarioCatalogPack(boName);
  return {
    boName: boName || '',
    scenarioTag: getScenarioTag(),
    catalogLoaded: !!pack?.scenarios?.length,
    catalogSummary: summarizeScenarioPack(pack),
    catalogStorageKey: catalogStorageKey(boName),
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

/** 仅读用户上传/已缓存的 catalog；无则 null（不 fallback 内置假清单） */
export function getScenarioCatalogPack(boName) {
  try {
    const key = catalogStorageKey(boName);
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = normalizeScenarioPack(JSON.parse(raw));
      if (parsed) {
        return parsed;
      }
    }
  } catch {
    // fall through
  }
  const fromDom = readScenarioCatalogFromDom();
  if (fromDom?.scenarios?.length && (!boName || !fromDom.boName || fromDom.boName === boName)) {
    return fromDom;
  }
  // 仅 GoodsIssue 可从 bundled 补；其它 BO 必须上传
  return getBundledScenarioPack(boName);
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
    if (!getScenarioTag()) {
      const firstTag = [...normalized.scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.tag;
      if (firstTag) {
        setScenarioTag(firstTag);
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
  const existing = getScenarioCatalogPack(boName);
  if (existing?.version === bundled.version) {
    return existing;
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
