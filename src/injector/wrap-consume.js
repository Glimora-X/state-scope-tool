import { flattenStatePatches } from './normalize.js';
import { filterTopLevelEntries } from './path-filter.js';
import { isWrapped, markWrapped } from './discover.js';
import { collectOldEntriesFromChangeData } from './wrap-old.js';
import {
  collectDetailFinalStates,
  collectMainFinalStates,
  installLegacyDiagnostics,
  mergeScope,
  summarizeChangeScope,
  takeScopeDiagnostics
} from './legacy-diagnostics.js';

export function wrapFormController(formController, epochManager) {
  if (!formController || isWrapped(formController)) {
    return false;
  }

  const original = formController.refreshView?.bind(formController);
  if (typeof original !== 'function') {
    return false;
  }

  formController.refreshView = function refreshViewWrapped(changedFields, validateInfo, statePatches) {
    const uiState = formController.presenter?.controllers?.uiStateController;
    const presenter = formController.presenter;

    if (uiState) {
      installLegacyDiagnostics(uiState, presenter, formController);
    }

    const response = original(changedFields, validateInfo, statePatches);
    const scope = mergeScope(
      takeScopeDiagnostics(),
      summarizeChangeScope(changedFields, presenter, formController)
    );

    const hasOld = changedFields && uiState;
    const hasNew = statePatches && Object.keys(statePatches).length > 0;
    if (!hasOld && !hasNew) {
      return response;
    }

    epochManager.beginEpoch('refreshView', 'incremental');
    epochManager.setScope(scope);

    if (hasOld) {
      epochManager.recordChangedSample(collectOldEntriesFromChangeData(uiState, changedFields));

      const finalSnap = {};
      if ((changedFields?.main?.length || 0) > 0 || (scope?.mainRecalcCount || 0) > 0) {
        Object.assign(finalSnap, collectMainFinalStates(uiState, presenter, formController));
      }
      Object.assign(finalSnap, collectDetailFinalStates(uiState, changedFields));
      epochManager.recordFinal(finalSnap);
    }

    if (hasNew) {
      epochManager.recordNew(filterTopLevelEntries(flattenStatePatches(statePatches)));
    }

    epochManager.commitEpoch();
    return response;
  };

  markWrapped(formController);

  const presenter = formController.presenter;
  if (presenter?.controllers?.uiStateController) {
    installLegacyDiagnostics(presenter.controllers.uiStateController, presenter, formController);
  }

  return true;
}
