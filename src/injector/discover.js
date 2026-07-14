/**
 * 运行时目标发现：仅走 React Fiber / window 已知锚点，禁止全量 window BFS。
 * 全量扫描会触发 MDF DataModel 属性访问并刷「xxx不存在」日志。
 */

const WRAPPED = Symbol('stateScopeWrapped');

/** 手动 rediscover({ deepScan: true }) 时才启用（仍尽量收窄范围） */
const SCAN_KEYS = [
  'controllers',
  'presenter',
  'formController',
  'viewModel',
  'bizController',
  'model',
  'stateManager'
];

function safeOwn(obj, key) {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  try {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      return undefined;
    }
    return obj[key];
  } catch {
    return undefined;
  }
}

function safeHasFn(obj, key) {
  const value = safeOwn(obj, key);
  return typeof value === 'function';
}

/** MDF ContainerModel：有 props Map / gridModel+root，禁止对其做属性探测 */
export function isMdfModelLike(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  try {
    if (candidate.props instanceof Map) {
      return true;
    }
    if (candidate.gridModel && candidate.root && candidate.cache) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function isVoucherPresenter(candidate) {
  if (!candidate || isMdfModelLike(candidate)) {
    return false;
  }

  const controllers = safeOwn(candidate, 'controllers');
  if (!controllers) {
    return false;
  }

  const uiStateController = safeOwn(controllers, 'uiStateController');
  const formController = safeOwn(controllers, 'formController');

  return !!(
    safeHasFn(uiStateController, 'getFieldState') &&
    safeHasFn(formController, 'refreshView') &&
    (safeOwn(candidate, 'voucherBoName') || safeOwn(candidate, 'boName'))
  );
}

export function isUiStateController(candidate) {
  if (!candidate || isMdfModelLike(candidate)) {
    return false;
  }

  return !!(
    safeHasFn(candidate, 'getFieldState') &&
    safeHasFn(candidate, 'getMainFieldState') &&
    safeHasFn(candidate, 'checkChangeStates') &&
    safeOwn(candidate, 'stateCollectors')
  );
}

export function isFormController(candidate) {
  if (!candidate || isMdfModelLike(candidate)) {
    return false;
  }

  const presenter = safeOwn(candidate, 'presenter');
  const controllers = presenter ? safeOwn(presenter, 'controllers') : null;

  return !!(safeHasFn(candidate, 'refreshView') && controllers && safeOwn(controllers, 'uiStateController'));
}

export function isBizApplicationLike(candidate) {
  if (!candidate || isMdfModelLike(candidate)) {
    return false;
  }

  return !!(
    safeOwn(candidate, 'stateManager') &&
    safeHasFn(candidate, 'dispatchAction') &&
    (typeof safeOwn(candidate, 'boName') === 'string' || safeOwn(candidate, 'options')?.boName)
  );
}

export function isLowcodeViewModel(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  // ContainerModel：viewMeta + get 即低代码 VM（boNames/getDisable 可能尚未就绪）
  try {
    if (candidate.viewMeta?.billType && typeof candidate.get === 'function') {
      return true;
    }
  } catch {
    // ignore
  }

  if (!isMdfModelLike(candidate)) {
    return false;
  }

  // TemplateView 根 VM：boNames / gridModel.bo；加载早期可能尚无 getDisable
  try {
    if (Array.isArray(candidate.boNames) && candidate.boNames.length > 0) {
      return true;
    }
    if (Array.isArray(candidate.root?.boNames) && candidate.root.boNames.length > 0) {
      return true;
    }
  } catch {
    // ignore
  }

  const gridModel = safeOwn(candidate, 'gridModel');
  try {
    if (gridModel && safeHasFn(gridModel, 'get') && typeof gridModel.get('bo') === 'string') {
      return true;
    }
  } catch {
    // ignore
  }

  try {
    return safeHasFn(candidate, 'get') && typeof candidate.get('getDisable') === 'function';
  } catch {
    return false;
  }
}

function getDomFiberRoots() {
  const nodes = [
    document.getElementById('root'),
    document.getElementById('app'),
    document.querySelector('[id*="root"]'),
    document.body
  ].filter(Boolean);

  const fibers = [];
  const seen = new Set();

  function pushFiber(fiber) {
    if (fiber && !seen.has(fiber)) {
      seen.add(fiber);
      fibers.push(fiber);
    }
  }

  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      if (
        key.startsWith('__reactFiber') ||
        key.startsWith('__reactContainer') ||
        key.startsWith('__reactInternalInstance')
      ) {
        pushFiber(node[key]);
      }
    }
  }
  return fibers;
}

function walkFiber(fiber, visit, depth = 0, maxDepth = 120) {
  if (!fiber || depth > maxDepth) {
    return null;
  }

  const hit = visit(fiber);
  if (hit) {
    return hit;
  }

  // React 15 internal instance
  const legacy = fiber._renderedComponent || fiber._currentElement;
  if (legacy && depth < maxDepth) {
    const fromLegacy = walkFiber(legacy, visit, depth + 1, maxDepth);
    if (fromLegacy) {
      return fromLegacy;
    }
  }

  const stateNode = fiber.stateNode;
  if (stateNode && typeof stateNode === 'object') {
    // React 15 class：TemplateView.viewModel 在 stateNode.state
    if (stateNode.state && depth < maxDepth) {
      const hitFromSn = visit({
        memoizedProps: stateNode.props || {},
        stateNode,
        memoizedState: stateNode.state
      });
      if (hitFromSn) {
        return hitFromSn;
      }
    }

    const inst = stateNode._reactInternalInstance || stateNode.__reactInternalInstance;
    if (inst && depth < maxDepth) {
      const fromInst = walkFiber(inst, visit, depth + 1, maxDepth);
      if (fromInst) {
        return fromInst;
      }
    }
  }

  let child = fiber.child || fiber._child;
  while (child) {
    const found = walkFiber(child, visit, depth + 1, maxDepth);
    if (found) {
      return found;
    }
    child = child.sibling || child._sibling;
  }

  return null;
}

function pickFromFiberPropNames(propNames, matcher) {
  const fibers = getDomFiberRoots();

  for (const fiber of fibers) {
    const found = walkFiber(fiber, (node) => {
      const props = node.memoizedProps || node.pendingProps || {};
      const stateNode = node.stateNode;
      const state = stateNode?.state || node.memoizedState;
      const candidates = [];

      for (const name of propNames) {
        // MDF TemplateView：viewModel 在 state，不在 props
        candidates.push(
          props[name],
          stateNode?.[name],
          stateNode?.props?.[name],
          state?.[name],
          stateNode?.viewModel
        );
      }

      for (const candidate of candidates) {
        if (candidate && matcher(candidate)) {
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

export function discoverPresenterViaReact() {
  return pickFromFiberPropNames(['presenter', 'voucherPresenter'], isVoucherPresenter);
}

function normalizeBillToken(value) {
  return String(value || '')
    .replace(/detail$/i, '')
    .replace(/[-_]/g, '')
    .toLowerCase();
}

function viewModelMatchesBoName(viewModel, expectedBoName) {
  if (!viewModel || !expectedBoName) {
    return true;
  }
  const expected = normalizeBillToken(expectedBoName);
  try {
    if (Array.isArray(viewModel.boNames) && viewModel.boNames.some((n) => normalizeBillToken(n) === expected)) {
      return true;
    }
  } catch {
    // ignore
  }
  try {
    const billNo = viewModel.viewMeta?.billNo;
    if (billNo && normalizeBillToken(billNo) === expected) {
      return true;
    }
    const entity = viewModel.viewMeta?.entityName || viewModel.viewMeta?.boName;
    if (entity && normalizeBillToken(entity) === expected) {
      return true;
    }
  } catch {
    // ignore
  }
  return resolveBoNameFromViewModel(viewModel) === expectedBoName;
}

/** MDF 官方：window.mdf = appManager；兼容 top / 同源 iframe */
function collectMdfAppManagerRoots() {
  const roots = [];
  const push = (mdf) => {
    if (mdf && !roots.includes(mdf)) {
      roots.push(mdf);
    }
  };

  try {
    push(window.mdf);
  } catch {
    // ignore
  }

  try {
    if (window.top && window.top !== window) {
      push(window.top.mdf);
    }
  } catch {
    // cross-origin top
  }

  try {
    for (let i = 0; i < window.frames.length; i += 1) {
      try {
        push(window.frames[i]?.mdf);
      } catch {
        // cross-origin frame
      }
    }
  } catch {
    // ignore
  }

  return roots;
}

/** MDF 官方：window.mdf = appManager，cur = 当前可见 ContainerModel */
function discoverLowcodeViewModelFromAppManager(expectedBoName = '') {
  const candidates = [];

  const push = (vm) => {
    if (vm && !candidates.includes(vm)) {
      candidates.push(vm);
    }
  };

  for (const mdf of collectMdfAppManagerRoots()) {
    try {
      push(mdf.cur);
    } catch {
      // ignore
    }

    try {
      if (typeof mdf.get === 'function') {
        for (let i = 0; i < 5; i += 1) {
          push(mdf.get(i));
        }
      }
    } catch {
      // ignore
    }

    try {
      if (mdf.viewInstances instanceof Map) {
        for (const vm of mdf.viewInstances.values()) {
          push(vm);
        }
      }
    } catch {
      // ignore
    }
  }

  for (const vm of candidates) {
    if (isLowcodeViewModel(vm) && viewModelMatchesBoName(vm, expectedBoName)) {
      return vm;
    }
  }

  for (const vm of candidates) {
    if (isLowcodeViewModel(vm)) {
      return vm;
    }
  }

  return null;
}

function discoverLowcodeViewModelViaReact() {
  return pickFromFiberPropNames(['viewModel', 'vm', 'rootViewModel'], isLowcodeViewModel);
}

/** @deprecated 仅 deepScan 手动调用 */
function scanObjectTree(root, matcher, maxDepth = 6) {
  const queue = [{ value: root, depth: 0 }];
  const seen = new WeakSet();

  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value) || depth > maxDepth) {
      continue;
    }
    seen.add(value);

    if (!isMdfModelLike(value) && matcher(value)) {
      return value;
    }

    if (isMdfModelLike(value)) {
      if (matcher === isLowcodeViewModel && matcher(value)) {
        return value;
      }
      continue;
    }

    if (depth >= maxDepth) {
      continue;
    }

    for (const key of SCAN_KEYS) {
      const child = safeOwn(value, key);
      if (child && typeof child === 'object') {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }

  return null;
}

/** @deprecated 仅 deepScan 手动调用；最多扫 40 个 window 顶层 key */
function scanWindowLimited(matcher, maxDepth = 5) {
  const skip = new Set(['window', 'document', 'location', 'top', 'parent', 'frames', 'self', 'chrome']);
  let scanned = 0;

  try {
    for (const key of Object.keys(window)) {
      if (skip.has(key) || key.startsWith('webkit')) {
        continue;
      }
      scanned += 1;
      if (scanned > 40) {
        break;
      }
      try {
        const found = scanObjectTree(window[key], matcher, maxDepth);
        if (found) {
          return found;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export function discoverBizApplication({ deepScan = false } = {}) {
  if (isBizApplicationLike(window.bizApplication)) {
    return window.bizApplication;
  }
  return deepScan ? scanWindowLimited(isBizApplicationLike, 4) : null;
}

export function discoverPresenter({ deepScan = false } = {}) {
  const fromFiber = discoverPresenterViaReact();
  if (fromFiber) {
    return fromFiber;
  }
  return deepScan ? scanWindowLimited(isVoucherPresenter, 4) : null;
}

export function discoverUiStateController(presenter, { deepScan = false } = {}) {
  const controllers = presenter ? safeOwn(presenter, 'controllers') : null;
  const fromPresenter = controllers ? safeOwn(controllers, 'uiStateController') : null;
  if (isUiStateController(fromPresenter)) {
    return fromPresenter;
  }
  return deepScan ? scanWindowLimited(isUiStateController, 4) : null;
}

export function discoverFormController(presenter, { deepScan = false } = {}) {
  const controllers = presenter ? safeOwn(presenter, 'controllers') : null;
  const fromPresenter = controllers ? safeOwn(controllers, 'formController') : null;
  if (isFormController(fromPresenter)) {
    return fromPresenter;
  }
  return deepScan ? scanWindowLimited(isFormController, 4) : null;
}

export function discoverLowcodeViewModel({ deepScan = false, expectedBoName = '' } = {}) {
  const boHint = expectedBoName || resolveBoNameFromRoute();

  const fromMdf = discoverLowcodeViewModelFromAppManager(boHint);
  if (fromMdf) {
    return fromMdf;
  }

  const fromFiber = discoverLowcodeViewModelViaReact();
  if (fromFiber) {
    return fromFiber;
  }

  if (deepScan) {
    const fromWindow = scanWindowLimited(isLowcodeViewModel, 4);
    if (fromWindow) {
      return fromWindow;
    }
  }

  return null;
}

const KNOWN_ROUTE_BO_ALIASES = {
  OutsourceIssue: 'OutsourceIssue',
  outsourceIssue: 'OutsourceIssue',
  OutsourceStockin: 'OutsourceStockin',
  outsourceStockin: 'OutsourceStockin',
  MpManufactureOrder: 'MpManufactureOrder',
  mpManufactureOrder: 'MpManufactureOrder',
  GoodsIssue: 'GoodsIssue',
  goodsIssue: 'GoodsIssue',
  SalesOrder: 'SalesOrder',
  salesOrder: 'SalesOrder'
};

const BO_NAME_HINTS = new Set(Object.values(KNOWN_ROUTE_BO_ALIASES));

export function resolveBoNameFromViewModel(viewModel) {
  if (!viewModel) {
    return '';
  }
  try {
    if (Array.isArray(viewModel.boNames) && viewModel.boNames[0]) {
      return String(viewModel.boNames[0]);
    }
  } catch {
    // ignore
  }
  try {
    const gridBo = viewModel.gridModel?.get?.('bo');
    if (typeof gridBo === 'string' && gridBo) {
      return gridBo;
    }
  } catch {
    // ignore
  }
  try {
    const boNames = viewModel.root?.boNames || viewModel.get?.('boNames');
    if (Array.isArray(boNames) && boNames[0]) {
      return String(boNames[0]);
    }
    const bo = viewModel.get?.('bo') || viewModel.get?.('boName');
    if (typeof bo === 'string' && bo) {
      return bo;
    }
  } catch {
    // ignore
  }
  return '';
}

/**
 * 低代码路由兜底：#/voucher/outsourceIssue-new/... 或 pageParams.routeParams.groupId
 * 不依赖 viewModel 是否已挂载。
 */
export function resolveBoNameFromRoute() {
  try {
    const href = `${window.location.hash || ''}${window.location.search || ''}`;

    // 优先 pageParams.groupId（最准）
    const pageParamsMatch = (window.location.search || href).match(/pageParams=([^&]+)/);
    if (pageParamsMatch?.[1]) {
      try {
        const params = JSON.parse(decodeURIComponent(pageParamsMatch[1]));
        const groupId = params?.routeParams?.groupId || params?.menuInfo?.routeParams?.groupId;
        if (typeof groupId === 'string' && groupId) {
          return KNOWN_ROUTE_BO_ALIASES[groupId] || groupId;
        }
      } catch {
        // ignore
      }
    }

    const groupMatch = href.match(/groupId(?:%22)?[:=](?:%22|")?([A-Za-z][A-Za-z0-9]*)/);
    if (groupMatch?.[1]) {
      const mapped = KNOWN_ROUTE_BO_ALIASES[groupMatch[1]];
      if (mapped || BO_NAME_HINTS.has(groupMatch[1])) {
        return mapped || groupMatch[1];
      }
    }

    // #/voucher/outsourceIssue-new/...
    const billMatch = href.match(/#?\/?voucher\/([A-Za-z][A-Za-z0-9]*)(?:-|\/|\?|&|$)/);
    if (billMatch?.[1]) {
      const raw = billMatch[1];
      const mapped = KNOWN_ROUTE_BO_ALIASES[raw];
      if (mapped) {
        return mapped;
      }
      const pascal = raw.charAt(0).toUpperCase() + raw.slice(1);
      if (KNOWN_ROUTE_BO_ALIASES[pascal] || BO_NAME_HINTS.has(pascal)) {
        return KNOWN_ROUTE_BO_ALIASES[pascal] || pascal;
      }
    }

    for (const [alias, bo] of Object.entries(KNOWN_ROUTE_BO_ALIASES)) {
      if (href.includes(alias)) {
        return bo;
      }
    }
  } catch {
    // ignore
  }
  return '';
}

export function resolveBoName({ bizApplication, presenter, formController, viewModel }) {
  return (
    safeOwn(bizApplication, 'boName') ||
    safeOwn(bizApplication, 'options')?.boName ||
    safeOwn(presenter, 'voucherBoName') ||
    safeOwn(presenter, 'boName') ||
    safeOwn(formController, 'presenter')?.voucherBoName ||
    safeOwn(formController, 'presenter')?.boName ||
    resolveBoNameFromViewModel(viewModel) ||
    resolveBoNameFromRoute() ||
    ''
  );
}

export function discoverRuntimeTargets(options = {}) {
  const deepScan = options.deepScan === true;
  const routeBoName = resolveBoNameFromRoute();
  // 优先 window.mdf.cur（MDF 官方），再 Fiber；低代码页禁止仅 deepScan 才找 VM
  const lowcodeViewModel = discoverLowcodeViewModel({
    deepScan: deepScan || !!routeBoName,
    expectedBoName: routeBoName
  });

  const presenter = discoverPresenter({ deepScan });
  const formController = discoverFormController(presenter, { deepScan });
  const presenterBizApplication = safeOwn(safeOwn(presenter, 'bizController'), 'bizApplication');
  let bizApplication = discoverBizApplication({ deepScan });

  if (isBizApplicationLike(presenterBizApplication)) {
    bizApplication = presenterBizApplication;
  }

  const formPresenter = formController ? safeOwn(formController, 'presenter') : null;
  const formControllers = formPresenter ? safeOwn(formPresenter, 'controllers') : null;
  const uiFromForm = formControllers ? safeOwn(formControllers, 'uiStateController') : null;

  const uiStateController = discoverUiStateController(presenter, { deepScan }) || uiFromForm || null;

  const boName = resolveBoName({ bizApplication, presenter, formController, viewModel: lowcodeViewModel });

  return {
    bizApplication,
    presenter,
    bizController: safeOwn(presenter, 'bizController') || null,
    uiStateController,
    formController,
    viewModel: lowcodeViewModel,
    boName
  };
}

export function markWrapped(target) {
  target[WRAPPED] = true;
}

export function unmarkWrapped(target) {
  if (target) {
    try {
      delete target[WRAPPED];
    } catch {
      // ignore
    }
  }
}

export function isWrapped(target) {
  return !!target?.[WRAPPED];
}
