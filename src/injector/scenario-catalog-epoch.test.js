import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeCatalogEpoch } from '../shared/scenario-catalog-epoch.js';
import { normalizeScenarioPack } from '../shared/scenario-catalog.js';

/** C1–C5：历史上「缓存没刷新」fault → 校验 catalogEpoch 粒度 */
const baseDomainPack = {
  boName: 'OutsourceStockin',
  version: 'v1',
  profile: 'lowcode',
  allowlistRef: 'outsourceStockin.allowlist.v1.json',
  stateScopeProfile: {
    compareFields: ['main.currencyId.disabled', 'main.vendorId.disabled']
  },
  scenarios: [
    {
      id: 'OS-S01',
      setup: '新增空白委外入库单',
      actions: ['打开单据'],
      assertFields: [{ path: 'main.currencyId', stateType: 'disabled', expected: true }],
      allowlistBatch: ['1-A']
    },
    {
      id: 'OS-S02',
      setup: '选单生单',
      actions: ['选单生成'],
      assertFields: [{ path: 'main.vendorId', stateType: 'disabled', expected: true }],
      allowlistBatch: ['1-B']
    }
  ]
};

describe('catalogEpoch C1–C5 fixtures', () => {
  it('C2: same v1 but assertFields.expected change → epoch changes', () => {
    const a = normalizeScenarioPack(baseDomainPack);
    const changed = {
      ...baseDomainPack,
      scenarios: baseDomainPack.scenarios.map((s, i) =>
        i === 0
          ? {
              ...s,
              assertFields: [{ path: 'main.currencyId', stateType: 'disabled', expected: false }]
            }
          : s
      )
    };
    const b = normalizeScenarioPack(changed);
    assert.ok(a.catalogEpoch);
    assert.ok(b.catalogEpoch);
    assert.notEqual(a.catalogEpoch, b.catalogEpoch);
  });

  it('C2b: add scenario OS-S03 → epoch changes', () => {
    const a = normalizeScenarioPack(baseDomainPack);
    const b = normalizeScenarioPack({
      ...baseDomainPack,
      scenarios: [
        ...baseDomainPack.scenarios,
        {
          id: 'OS-S03',
          setup: '币种为本位币',
          actions: ['选择本位币'],
          assertFields: [{ path: 'main.exchangeRate', stateType: 'disabled', expected: true }],
          allowlistBatch: ['1-A']
        }
      ]
    });
    assert.notEqual(a.catalogEpoch, b.catalogEpoch);
  });

  it('C3: different boName → different epoch', () => {
    const stockin = normalizeScenarioPack(baseDomainPack);
    const issue = normalizeScenarioPack({
      ...baseDomainPack,
      boName: 'OutsourceIssue',
      scenarios: baseDomainPack.scenarios.map((s) => ({
        ...s,
        id: s.id.replace('OS-', 'OI-')
      }))
    });
    assert.notEqual(stockin.catalogEpoch, issue.catalogEpoch);
  });

  it('C4: same content → same epoch (source switch is sync concern, not hash)', () => {
    const manual = normalizeScenarioPack({ ...baseDomainPack, source: undefined });
    const registry = normalizeScenarioPack(baseDomainPack);
    const registryTagged = { ...registry, source: 'window-registry' };
    assert.equal(manual.catalogEpoch, registry.catalogEpoch);
    assert.equal(computeCatalogEpoch(manual), computeCatalogEpoch(registryTagged));
  });

  it('C5: note-only change → epoch unchanged', () => {
    const a = normalizeScenarioPack(baseDomainPack);
    const b = normalizeScenarioPack({
      ...baseDomainPack,
      note: '历史文案改了很多字但与规则无关'
    });
    assert.equal(a.catalogEpoch, b.catalogEpoch);
  });

  it('C1/C5: title/checkpoint-only on tool pack does not affect epoch when rules same', () => {
    const tool = {
      boName: 'OutsourceStockin',
      version: 'v1',
      source: 'ssot-upload',
      scenarios: [
        {
          tag: 'os-s01',
          order: 10,
          group: 'OS-S01',
          label: 'A',
          checkpoint: '旧文案',
          signOffMode: 'allowlist',
          watchFields: [{ path: 'main.currencyId', stateType: 'disabled' }],
          steps: [],
          assertFields: [{ path: 'main.currencyId', stateType: 'disabled', expected: true }],
          allowlistBatch: ['1-A'],
          setup: '新增空白委外入库单',
          actions: ['打开单据']
        }
      ]
    };
    const a = normalizeScenarioPack(tool);
    const b = normalizeScenarioPack({
      ...tool,
      title: '新标题',
      note: '新 note',
      scenarios: [{ ...tool.scenarios[0], checkpoint: '新文案', label: 'B' }]
    });
    assert.equal(a.catalogEpoch, b.catalogEpoch);
  });

  it('computeCatalogEpoch is stable for same payload', () => {
    const once = computeCatalogEpoch(baseDomainPack);
    const twice = computeCatalogEpoch(baseDomainPack);
    assert.equal(once, twice);
    assert.match(once, /^[0-9a-f]{8}$/);
  });
});
