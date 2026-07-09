import goodsIssueL3 from '../../scenarios/GoodsIssue.L3.v1.json';

/**
 * 仅传统试点 GoodsIssue 内置。
 * 低代码等领域 BO 必须上传领域 SSOT（如 outsourceIssue.scenarios.v1.json）。
 */
export const BUNDLED_SCENARIO_PACKS = {
  GoodsIssue: goodsIssueL3
};

export function getBundledScenarioPackRaw(boName) {
  if (boName && BUNDLED_SCENARIO_PACKS[boName]) {
    return BUNDLED_SCENARIO_PACKS[boName];
  }
  return null;
}
