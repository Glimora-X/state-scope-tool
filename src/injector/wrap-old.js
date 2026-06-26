import {
  buildOldPath,
  normalizeOldFieldState
} from './normalize.js';
import { filterTopLevelEntries } from './path-filter.js';
import { isWrapped, markWrapped } from './discover.js';
import {
  collectDetailFinalStates,
  collectMainFinalStates,
  installLegacyDiagnostics,
  mergeScope,
  summarizeChangeScope,
  takeScopeDiagnostics
} from './legacy-diagnostics.js';

function collectOldEntriesFromChangeData(uiState, changeData) {
  const entries = {};

  if (changeData?.main?.length) {
    for (const fieldName of changeData.main) {
      if (String(fieldName).includes('.')) {
        continue;
      }
      const result = uiState.getMainFieldState(fieldName);
      const normalized = normalizeOldFieldState(result);
      for (const [stateType, value] of Object.entries(normalized)) {
        entries[`${buildOldPath('main', 'main', fieldName)}.${stateType}`] = value;
      }
    }
  }

  if (changeData?.body) {
    for (const detailName of Object.keys(changeData.body)) {
      const bodyChange = changeData.body[detailName];
      const rowRefs = [
        ...(bodyChange?.insertUuids || []),
        ...(bodyChange?.updateUuids || [])
      ];

      for (const rowRef of rowRefs) {
        const uuid = typeof rowRef === 'string' ? rowRef : rowRef?.uuid;
        const fields = rowRef?.fields;
        if (!uuid || uuid === 'undefined') {
          continue;
        }

        if (Array.isArray(fields) && fields.length > 0) {
          for (const fieldName of fields) {
            if (String(fieldName).includes('.')) {
              continue;
            }
            const result = uiState.getFieldState(detailName, uuid, fieldName);
            const normalized = normalizeOldFieldState(result);
            for (const [stateType, value] of Object.entries(normalized)) {
              entries[`${buildOldPath(detailName, uuid, fieldName)}.${stateType}`] = value;
            }
          }
        }
      }
    }
  }

  return filterTopLevelEntries(entries);
}

/**
 * FormController 未 hook 时的降级：仅 wrap checkChangeStates。
 */
export function wrapUiStateController(uiState, epochManager, presenter) {
  if (!uiState || isWrapped(uiState)) {
    return false;
  }

  installLegacyDiagnostics(uiState, presenter, null);

  const instrumentedCheck = uiState.checkChangeStates.bind(uiState);
  uiState.checkChangeStates = (changeData) => {
    const result = instrumentedCheck(changeData);
    const scope = mergeScope(takeScopeDiagnostics(), summarizeChangeScope(changeData, presenter, null));

    epochManager.beginEpoch('checkChangeStates', 'incremental');
    epochManager.setScope(scope);
    epochManager.recordChangedSample(collectOldEntriesFromChangeData(uiState, changeData));

    const finalSnap = {};
    if ((changeData?.main?.length || 0) > 0 || (scope?.mainRecalcCount || 0) > 0) {
      Object.assign(finalSnap, collectMainFinalStates(uiState, presenter));
    }
    Object.assign(finalSnap, collectDetailFinalStates(uiState, changeData));
    epochManager.recordFinal(finalSnap);
    epochManager.commitEpoch();

    return result;
  };

  markWrapped(uiState);
  return true;
}

export { collectOldEntriesFromChangeData };
