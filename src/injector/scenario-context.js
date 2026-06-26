import { SCENARIO_CATALOG } from '../shared/scenario-catalog.js';

const STORAGE_KEY = 'stateScopeScenario';

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

export function getScenarioCatalog() {
  return SCENARIO_CATALOG;
}
