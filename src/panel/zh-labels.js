/**
 * Panel 用中文词表（非 module，挂到 window.StateScopeZh）
 * 与 src/shared/zh-labels.js 语义保持一致。
 *
 * 升级前 = finalSnap；升级后 = shadowStore；
 * 影子未写入 = 框架采集正常，存储未落盘。
 */
(function (global) {
  const ZH = {
    epoch: '观测轮次',
    epochShort: '轮次',
    epochTimeline: '观测时间线',
    epochDetail: '观测详情',
    epochJson: '观测轮次 JSON',
    noEpoch: '尚无观测轮次',
    waitEpoch: '等待观测轮次',
    mismatch: '不一致',
    legacyTrack: '升级前',
    newTrack: '升级后',
    dualTrack: '升级前后',
    shadow: '升级后'
  };

  const SEVERITY_ZH = {
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

  const SHADOW_STORE_MISSING = {
    short: '影子未写入',
    headline: '框架已采到升级前；影子存储未写入',
    subline: 'statePatches 可能已算完，但 shadowStore 无该字段终态（非字段清单/采集框架问题）',
    bannerLowcode:
      '框架正常：已采到升级前（用户所见）。问题在存储：升级后 shadowStore 未写入。statePatches 有值也不算接入，须 applyStatePatches(shadow) 落盘。',
    bannerTraditional:
      '框架正常：已采到升级前。问题在存储：升级后结果未写入，当前仅升级前预览。'
  };

  const NEW_ONLY_HINT = {
    short: '仅升级后',
    subline:
      '影子有值、升级前为 —。低代码明细常见原因是本轮未采到升级前（非 EditAble 已删）。先验 shadow 该 key，再查同轮 finalSnap（尤其 detailList）。',
    bannerLowcode:
      '「仅升级后」≠ 迁移删旧完成。先确认 shadowStore 有该 key；若 EditAble 仍在，多半是升级前 finalSnap 未采到（明细 allowlist 须主动采样）。'
  };

  function severityZh(severity) {
    if (!severity) {
      return '—';
    }
    return SEVERITY_ZH[severity] || String(severity);
  }

  function epochLabel(id) {
    if (id == null || id === '') {
      return ZH.epoch;
    }
    return `${ZH.epoch} #${id}`;
  }

  global.StateScopeZh = {
    ZH,
    SEVERITY_ZH,
    SHADOW_STORE_MISSING,
    NEW_ONLY_HINT,
    severityZh,
    epochLabel,
    DIFF_COUNTER_ZH: {
      ok: '升级前后一致',
      logicMismatch: '升级前后不一致',
      legacyOnly: '未升级',
      newOnly: '仅升级后',
      pending: '影子未写入',
      total: '合计'
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
