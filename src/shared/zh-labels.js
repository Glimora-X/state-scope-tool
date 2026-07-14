/**
 * StateScope 面向用户的中文词表。
 * 内部 severity / 字段名仍用英文 key，仅展示层调用本模块。
 *
 * 口径约定：
 * - 升级前 = 用户所见终值 finalSnap（迁移前/页面渲染态）
 * - 升级后 = 影子状态 shadowStore（迁移目标口径）
 * - statePatches = biz 算完的中间补丁；须写入 shadowStore 后才算升级后接入
 * - pending / 影子未写入 = 框架采集正常，但 shadowStore 未落库该字段
 * - 未升级 = 影子链路已通，但某字段仅升级前有数
 * - 仅升级后 = 影子有、升级前 —；低代码明细常见「本轮未采到」而非 EditAble 已删完
 *   排查：先验 shadow 该 key → 再查同轮 finalSnap 为何缺（尤其 detailList.{uuid}.*）
 */

export const ZH = {
  epoch: '观测轮次',
  epochShort: '轮次',
  epochTimeline: '观测时间线',
  epochDetail: '观测详情',
  epochJson: '观测轮次 JSON',
  epochCache: '页面缓存轮次',
  noEpoch: '尚无观测轮次',
  waitEpoch: '等待观测轮次',
  mismatch: '不一致',
  legacyTrack: '升级前',
  newTrack: '升级后',
  dualTrack: '升级前后',
  shadow: '升级后',
  allowlist: '字段清单',
  scenario: '场景'
};

/** Diff / allowlist 结果 severity → 中文 */
export const SEVERITY_ZH = {
  ok: '升级前后一致',
  'logic-mismatch': '升级前后不一致',
  'legacy-only': '未升级',
  '迁移未完成': '未升级',
  'new-only': '仅升级后',
  unobserved: '未观测',
  pending: '影子未写入',
  '待接入': '影子未写入',
  '升级后待接入': '影子未写入',
  '升级后未接入': '影子未写入',
  '未观测': '未观测',
  '影子状态未接入': '影子未写入',
  'shadow 未接入': '影子未写入'
};

/** 「仅升级后」说明：避免当成切流完成 */
export const NEW_ONLY_HINT = {
  short: '仅升级后',
  subline:
    '影子有值、升级前为 —。低代码明细常见原因是本轮未采到升级前（非 EditAble 已删）。先验 shadow 该 key，再查同轮 finalSnap（尤其 detailList）。',
  bannerLowcode:
    '「仅升级后」≠ 迁移删旧完成。先确认 shadowStore 有该 key；若 EditAble 仍在，多半是升级前 finalSnap 未采到（明细 allowlist 须主动采样）。'
};

export function severityZh(severity) {
  if (!severity) {
    return '—';
  }
  return SEVERITY_ZH[severity] || String(severity);
}

export function epochLabel(id) {
  if (id == null || id === '') {
    return ZH.epoch;
  }
  return `${ZH.epoch} #${id}`;
}

/** Diff 摘要计数器标题 */
export const DIFF_COUNTER_ZH = {
  ok: '升级前后一致',
  logicMismatch: '升级前后不一致',
  legacyOnly: '未升级',
  newOnly: '仅升级后',
  pending: '影子未写入',
  total: '合计'
};

/** 整轮无 shadow 时的说明：框架 OK，存储侧未写入 */
export const SHADOW_STORE_MISSING = {
  short: '影子未写入',
  headline: '框架已采到升级前；影子存储未写入',
  subline: 'statePatches 可能已算完，但 shadowStore 无该字段终态（非字段清单/采集框架问题）',
  bannerLowcode:
    '框架正常：已采到升级前（用户所见）。问题在存储：升级后 shadowStore 未写入。statePatches 有值也不算接入，须 applyStatePatches(shadow) 落盘。',
  bannerTraditional:
    '框架正常：已采到升级前。问题在存储：升级后结果未写入，当前仅升级前预览。'
};
