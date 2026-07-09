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
