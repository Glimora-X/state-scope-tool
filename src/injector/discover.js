/**
 * 在 MAIN world 中发现 bizApplication / presenter / uiStateController / FormController。
 */

const WRAPPED = Symbol('stateScopeWrapped');
const SCAN_KEYS = [
  'controllers',
  'presenter',
  'formController',
  'viewModel',
  'bizController',
  'model',
  'stateManager'
];

export function isVoucherPresenter(candidate) {
  return !!(
    candidate?.controllers?.uiStateController?.getFieldState &&
    candidate?.controllers?.formController?.refreshView &&
    (candidate.voucherBoName || candidate.boName)
  );
}

export function isUiStateController(candidate) {
  return (
    candidate &&
    typeof candidate.getFieldState === 'function' &&
    typeof candidate.getMainFieldState === 'function' &&
    typeof candidate.checkChangeStates === 'function' &&
    candidate.stateCollectors
  );
}

export function isFormController(candidate) {
  return (
    candidate &&
    typeof candidate.refreshView === 'function' &&
    candidate.presenter?.controllers?.uiStateController
  );
}

export function isBizApplicationLike(candidate) {
  return (
    candidate &&
    candidate.stateManager &&
    typeof candidate.dispatchAction === 'function' &&
    (typeof candidate.boName === 'string' || candidate.options?.boName)
  );
}

/** 仅 MDF 低代码 viewModel，避免把平台任意 get/set 对象误判为 lowcode */
export function isLowcodeViewModel(candidate) {
  if (!candidate || typeof candidate.get !== 'function' || typeof candidate.set !== 'function') {
    return false;
  }

  const hasMdfRoot = Array.isArray(candidate.root?.boNames) && candidate.root.boNames.length > 0;
  const hasGridBo =
    candidate.gridModel &&
    typeof candidate.gridModel.get === 'function' &&
    typeof candidate.gridModel.get('bo') === 'string';

  if (!hasMdfRoot && !hasGridBo) {
    return false;
  }

  try {
    return typeof candidate.get('getDisable') === 'function';
  } catch {
    return false;
  }
}

function scanObjectTree(root, matcher, maxDepth = 8) {
  const queue = [{ value: root, depth: 0 }];
  const seen = new WeakSet();

  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value) || depth > maxDepth) {
      continue;
    }
    seen.add(value);

    if (matcher(value)) {
      return value;
    }

    if (value.controllers?.uiStateController && matcher(value.controllers.uiStateController)) {
      return value.controllers.uiStateController;
    }

    if (value.controllers?.formController && matcher(value.controllers.formController)) {
      return value.controllers.formController;
    }

    if (isVoucherPresenter(value)) {
      return value;
    }

    if (value.bizController?.bizApplication && matcher(value.bizController.bizApplication)) {
      return value.bizController.bizApplication;
    }

    if (value.presenter?.controllers?.uiStateController && matcher(value.presenter.controllers.uiStateController)) {
      return value.presenter.controllers.uiStateController;
    }

    if (depth >= maxDepth) {
      continue;
    }

    for (const key of SCAN_KEYS) {
      try {
        if (value[key]) {
          queue.push({ value: value[key], depth: depth + 1 });
        }
      } catch {
        // ignore sealed objects
      }
    }
  }

  return null;
}

function scanWindow(matcher, maxDepth = 7) {
  try {
    for (const key of Object.keys(window)) {
      if (key === 'window' || key.startsWith('webkit')) {
        continue;
      }
      try {
        const found = scanObjectTree(window[key], matcher, maxDepth);
        if (found) {
          return found;
        }
      } catch {
        // ignore cross-origin getters
      }
    }
  } catch {
    // ignore
  }

  return scanObjectTree(window, matcher, 5);
}

function getDomFiberRoots() {
  const nodes = [
    document.getElementById('root'),
    document.getElementById('app'),
    document.querySelector('[id*="root"]'),
    document.body
  ].filter(Boolean);

  const fibers = [];
  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      if (key.startsWith('__reactFiber') || key.startsWith('__reactContainer')) {
        fibers.push(node[key]);
      }
    }
  }
  return fibers;
}

function walkFiber(fiber, visit, depth = 0, maxDepth = 100) {
  if (!fiber || depth > maxDepth) {
    return null;
  }

  const hit = visit(fiber);
  if (hit) {
    return hit;
  }

  let child = fiber.child;
  while (child) {
    const found = walkFiber(child, visit, depth + 1, maxDepth);
    if (found) {
      return found;
    }
    child = child.sibling;
  }

  return null;
}

export function discoverPresenterViaReact() {
  const fibers = getDomFiberRoots();

  for (const fiber of fibers) {
    const found = walkFiber(fiber, (node) => {
      const props = node.memoizedProps || node.pendingProps || {};
      const candidates = [
        props.presenter,
        props.voucherPresenter,
        node.stateNode?.presenter,
        node.stateNode?.props?.presenter
      ];

      for (const candidate of candidates) {
        if (isVoucherPresenter(candidate)) {
          return candidate;
        }
      }

      return null;
    });

    if (found) {
      return found;
    }
  }

  return null;
}

export function discoverBizApplication() {
  if (isBizApplicationLike(window.bizApplication)) {
    return window.bizApplication;
  }
  return scanWindow(isBizApplicationLike, 8);
}

export function discoverPresenter() {
  return discoverPresenterViaReact() || scanWindow(isVoucherPresenter, 8);
}

export function discoverUiStateController(presenter) {
  if (presenter?.controllers?.uiStateController) {
    return presenter.controllers.uiStateController;
  }
  return scanWindow(isUiStateController, 8);
}

export function discoverFormController(presenter) {
  if (presenter?.controllers?.formController) {
    return presenter.controllers.formController;
  }
  return scanWindow(isFormController, 8);
}

export function discoverLowcodeViewModel() {
  return scanWindow(isLowcodeViewModel, 8);
}

export function resolveBoName({ bizApplication, presenter, formController }) {
  return (
    bizApplication?.boName ||
    bizApplication?.options?.boName ||
    presenter?.voucherBoName ||
    presenter?.boName ||
    formController?.presenter?.voucherBoName ||
    formController?.presenter?.boName ||
    ''
  );
}

export function discoverRuntimeTargets() {
  const bizApplication = discoverBizApplication();
  const presenter = discoverPresenter();
  const formController = discoverFormController(presenter);
  const uiStateController =
    discoverUiStateController(presenter) ||
    formController?.presenter?.controllers?.uiStateController ||
    null;
  const viewModel = discoverLowcodeViewModel();
  const boName = resolveBoName({ bizApplication, presenter, formController });

  return {
    bizApplication,
    presenter,
    uiStateController,
    formController,
    viewModel,
    boName
  };
}

export function markWrapped(target) {
  target[WRAPPED] = true;
}

export function isWrapped(target) {
  return !!target?.[WRAPPED];
}
