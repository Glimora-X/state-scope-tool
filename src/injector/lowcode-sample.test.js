import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLowcodePathFromGetDisable } from './lowcode-paths.js';
import {
  alignLowcodeDetailIndexUuidKeys,
  parseAllowlistDetailPath,
  sampleAllowlistFieldStatesFromViewModel
} from './lowcode-sample.js';
import { diffSnapshots } from './diff.js';
import { buildAllowlistPathSet } from './allowlist-config.js';

describe('parseAllowlistDetailPath', () => {
  it('parses detailList.{uuid}.warehouseId', () => {
    assert.deepEqual(parseAllowlistDetailPath('detailList.{uuid}.warehouseId'), {
      bodyName: 'detailList',
      fieldName: 'warehouseId'
    });
  });

  it('rejects main paths', () => {
    assert.equal(parseAllowlistDetailPath('main.currencyId'), null);
  });
});

describe('sampleAllowlistFieldStatesFromViewModel detail', () => {
  it('actively samples detailList.{uuid}.warehouseId into finalSnap key with uuid', () => {
    const columnState = { disabled: true, visible: true };
    const gridModel = {
      name: 'detailList',
      data: [{ uuid: 'row-uuid-1', warehouseId: { id: 1 } }],
      getColumn(name) {
        if (name !== 'warehouseId') {
          return null;
        }
        return {
          get(stateType, options) {
            if (options?.scope?.index === 0 && stateType in columnState) {
              return columnState[stateType];
            }
            return undefined;
          }
        };
      }
    };

    const viewModel = {
      root: {
        gridModels: [gridModel],
        get() {
          return undefined;
        }
      }
    };

    const snap = sampleAllowlistFieldStatesFromViewModel(viewModel, {
      fields: [{ path: 'detailList.{uuid}.warehouseId', stateType: 'disabled' }]
    });

    assert.equal(snap['detailList.row-uuid-1.warehouseId.disabled'], true);
    assert.equal(snap['detailList.0.warehouseId.disabled'], undefined);
  });
});

describe('buildLowcodePathFromGetDisable', () => {
  it('prefers row uuid over index', () => {
    const grid = {
      name: 'detailList',
      data: [{ uuid: 'abc-uuid', warehouseId: {} }]
    };
    assert.equal(
      buildLowcodePathFromGetDisable('warehouseId', 0, grid, 'disabled'),
      'detailList.abc-uuid.warehouseId.disabled'
    );
  });
});

describe('alignLowcodeDetailIndexUuidKeys + diff', () => {
  it('single-row index vs uuid does not yield new-only', () => {
    const oldSnap = { 'detailList.0.warehouseId.disabled': false };
    const newSnap = { 'detailList.row-uuid-1.warehouseId.disabled': false };
    const { oldSnap: o, newSnap: n } = alignLowcodeDetailIndexUuidKeys(oldSnap, newSnap);

    assert.equal(o['detailList.row-uuid-1.warehouseId.disabled'], false);
    assert.equal(o['detailList.0.warehouseId.disabled'], undefined);
    assert.equal(n['detailList.row-uuid-1.warehouseId.disabled'], false);

    const allowlist = buildAllowlistPathSet({
      fields: [{ path: 'detailList.{uuid}.warehouseId' }]
    });
    const diffs = diffSnapshots(o, n, allowlist);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].severity, 'ok');
  });

  it('active sample + shadow same uuid is ok not new-only', () => {
    const finalSnap = { 'detailList.row-uuid-1.warehouseId.disabled': true };
    const shadowSnap = { 'detailList.row-uuid-1.warehouseId.disabled': true };
    const allowlist = buildAllowlistPathSet({
      fields: [{ path: 'detailList.{uuid}.warehouseId' }]
    });
    const diffs = diffSnapshots(finalSnap, shadowSnap, allowlist);
    assert.equal(diffs[0].severity, 'ok');
  });
});
