import goodsIssueV1 from '../../allowlists/GoodsIssue.v1.json';

/** 构建时内嵌，不依赖 content script fetch / CSP 允许的内联脚本 */
export const BUNDLED_ALLOWLISTS = {
  GoodsIssue: goodsIssueV1
};

export function getBundledAllowlist(boName) {
  if (boName && BUNDLED_ALLOWLISTS[boName]) {
    return BUNDLED_ALLOWLISTS[boName];
  }
  return null;
}
