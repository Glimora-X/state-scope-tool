import { isWrapped, markWrapped } from './discover.js';

export function wrapGetDisable(viewModel, epochManager) {
  if (!viewModel || typeof viewModel.get !== 'function' || isWrapped(viewModel)) {
    return false;
  }

  const original = viewModel.get('getDisable');
  if (typeof original !== 'function') {
    return false;
  }

  viewModel.set('getDisable', (name, index, obj) => {
    const result = original.call(viewModel, name, index, obj);
    const tableRef = obj?.name || 'detail';
    const pathBase = index == null || index === undefined
      ? `main.${name}`
      : `${tableRef}.row-${index}.${name}`;

    epochManager.beginEpoch('getDisable', 'incremental');
    epochManager.recordOld({
      [`${pathBase}.disabled`]: !!result
    });
    epochManager.commitEpoch();

    return result;
  });

  markWrapped(viewModel);
  return true;
}
