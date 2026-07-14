import { captureStatePatchesAsSnap } from './normalize.js';
import { isWrapped, markWrapped, unmarkWrapped } from './discover.js';
import { registerHook, markTriggered } from './hook-registry.js';
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

  const rawRefreshView = formController.refreshView;
  if (typeof rawRefreshView !== 'function') {
    return false;
  }

  const original = rawRefreshView.bind(formController);

  const wrapped = function refreshViewWrapped(changedFields, validateInfo, statePatches) {
    markTriggered('refreshView');
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
      epochManager.recordNew(captureStatePatchesAsSnap(statePatches));
    }

    epochManager.commitEpoch();
    return response;
  };
  formController.refreshView = wrapped;

  registerHook({
    name: 'refreshView',
    target: formController,
    methodName: 'refreshView',
    original: rawRefreshView,
    wrapped,
    onUnwrap() {
      formController.refreshView = rawRefreshView;
      unmarkWrapped(formController);
    }
  });

  markWrapped(formController);

  const presenter = formController.presenter;
  if (presenter?.controllers?.uiStateController) {
    installLegacyDiagnostics(presenter.controllers.uiStateController, presenter, formController);
  }

  return true;
}
