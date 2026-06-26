export const SCENARIO_CATALOG = [
  { tag: 'new', label: '新增', checkpoint: '表头 + 明细初始态' },
  { tag: 'edit', label: '编辑', checkpoint: '表头 + 明细初始态' },
  { tag: 'view', label: '查看', checkpoint: '表头 + 明细初始态' },
  { tag: 'copy-new', label: '复制新增', checkpoint: '表头 + 明细初始态' },
  { tag: 'audit-edit', label: '审核中修改', checkpoint: 'Scenario 规则' },
  { tag: 'detail-row-crud', label: '子表增删复制行', checkpoint: 'uuid 下行状态不串、不残留' },
  { tag: 'header-linkage', label: '表头改联动字段', checkpoint: '仅受影响字段变化' },
  { tag: 'nested-detail', label: '孙表嵌套', checkpoint: '路径完整' },
  { tag: 'data-grid-edit', label: 'data-grid-edit', checkpoint: '列表模式、选择态与状态分离' },
  { tag: 'manual', label: '手动标记', checkpoint: '非 §7.4 标准场景' }
];

export const MIGRATION_SCENARIO_TAGS = SCENARIO_CATALOG.filter((item) => item.tag !== 'manual').map(
  (item) => item.tag
);

export function getScenarioLabel(tag) {
  const hit = SCENARIO_CATALOG.find((item) => item.tag === tag);
  return hit?.label || tag || '—';
}

export function getScenarioCheckpoint(tag) {
  const hit = SCENARIO_CATALOG.find((item) => item.tag === tag);
  return hit?.checkpoint || '';
}
