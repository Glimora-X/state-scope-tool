/* global chrome */
window.StateScopeScenarioUI = (function createScenarioUI() {
  const CHECKLIST = [
    { tag: 'new', label: '新增', checkpoint: '表头 + 明细初始态' },
    { tag: 'edit', label: '编辑', checkpoint: '表头 + 明细初始态' },
    { tag: 'view', label: '查看', checkpoint: '表头 + 明细初始态' },
    { tag: 'copy-new', label: '复制新增', checkpoint: '表头 + 明细初始态' },
    { tag: 'audit-edit', label: '审核中修改', checkpoint: 'Scenario 规则' },
    { tag: 'detail-row-crud', label: '子表增删复制行', checkpoint: 'uuid 下行状态不串' },
    { tag: 'header-linkage', label: '表头改联动字段', checkpoint: '仅受影响字段变化' },
    { tag: 'nested-detail', label: '孙表嵌套', checkpoint: '路径完整' },
    { tag: 'data-grid-edit', label: 'data-grid-edit', checkpoint: '列表/选择态与状态分离' }
  ];

  function statusChip(status) {
    if (status === 'pass') {
      return 'on';
    }
    if (status === 'block') {
      return 'off';
    }
    return '';
  }

  function statusLabel(status) {
    const map = {
      not_started: '未开始',
      in_progress: '进行中',
      pass: 'PASS',
      block: 'BLOCK'
    };
    return map[status] || status;
  }

  function getReport(ctx) {
    return ctx.appState?.scenarioReport || null;
  }

  function getSelectedScenario(ctx) {
    return ctx.ui.selectedScenarioTag || ctx.ui.scenarioTag || CHECKLIST[0].tag;
  }

  function renderVerdict(ctx) {
    const report = getReport(ctx);
    const active = getSelectedScenario(ctx);
    if (!report) {
      return ctx.renderVerdict({
        status: 'idle',
        headline: '场景回归未开始',
        subline: '选择场景并操作单据'
      });
    }

    const summary = report.summary || {};
    const activeRecord = report.scenarios?.[active];
    if (activeRecord?.status === 'block') {
      return ctx.renderVerdict({
        status: 'error',
        headline: `BLOCK · ${activeRecord.label}`,
        subline: `${activeRecord.blockedFields} 字段 logic-mismatch · Epoch ${activeRecord.epochCount}`
      });
    }
    if (activeRecord?.status === 'pass') {
      return ctx.renderVerdict({
        status: 'ok',
        headline: `PASS · ${activeRecord.label}`,
        subline: `${activeRecord.readyFields}/${activeRecord.allowlistFieldCount} allowlist 字段就绪`
      });
    }
    if (summary.block > 0) {
      return ctx.renderVerdict({
        status: 'error',
        headline: `会话 BLOCK · ${summary.block} 个场景失败`,
        subline: `PASS ${summary.pass}/${summary.total} · 已签字 ${summary.markedComplete}`
      });
    }
    return ctx.renderVerdict({
      status: summary.pass === summary.total && summary.total > 0 ? 'ok' : 'warn',
      headline: `会话进行中 · PASS ${summary.pass}/${summary.total}`,
      subline: `已签字 ${summary.markedComplete}/${summary.total}`
    });
  }

  function renderChecklist(ctx) {
    const report = getReport(ctx);
    const selected = getSelectedScenario(ctx);
    return `<div class="scenario-checklist">${CHECKLIST.map((item) => {
      const record = report?.scenarios?.[item.tag] || { status: 'not_started', markedComplete: false, epochCount: 0 };
      const active = selected === item.tag ? ' active' : '';
      const completeMark = record.markedComplete ? ' ✓签字' : '';
      return `<button type="button" class="scenario-item${active}" data-select-scenario="${item.tag}">
        <div class="scenario-item-head">
          <span class="chip ${statusChip(record.status)}">${statusLabel(record.status)}</span>
          <strong>${ctx.esc(item.label)}</strong>
          ${completeMark ? `<span class="subtle">${completeMark}</span>` : ''}
        </div>
        <div class="subtle">${ctx.esc(item.checkpoint)}</div>
        <div class="subtle">Epoch ${record.epochCount || 0}${record.logicMismatchCount ? ` · mismatch ${record.logicMismatchCount}` : ''}</div>
      </button>`;
    }).join('')}</div>`;
  }

  function renderScenarioDetail(ctx) {
    const report = getReport(ctx);
    const tag = getSelectedScenario(ctx);
    const record = report?.scenarios?.[tag];
    const meta = CHECKLIST.find((item) => item.tag === tag);

    if (!record) {
      return '<div class="empty">选择左侧场景</div>';
    }

    const canMark = record.markedComplete || record.status === 'pass';
    const fields =
      record.fields?.length ?
        record.fields
          .map(
            (field) => `<tr class="${field.logicMismatchCount > 0 ? 'row-bad' : field.scenarioReady ? 'row-ok' : ''}">
          <td><div class="field-name">${ctx.esc(field.path)}</div><div class="field-path">${ctx.esc(field.stateType)}</div></td>
          <td>${field.epochCount}</td>
          <td>${field.logicMismatchCount}</td>
          <td>${field.scenarioReady ? '<span class="chip on">READY</span>' : `<span class="chip off">${ctx.esc(field.blockReason || '—')}</span>`}</td>
        </tr>`
          )
          .join('')
      : `<tr><td colspan="4" class="empty">本场景尚无 allowlist 字段观测。请加载 allowlist 并在该场景下操作单据。</td></tr>`;

    return `<div>
      <div class="detail-head">
        <div>
          <div class="detail-title">${ctx.esc(meta?.label || tag)}</div>
          <div class="subtle">${ctx.esc(meta?.checkpoint || '')}</div>
        </div>
        <span class="chip ${statusChip(record.status)}">${statusLabel(record.status)}</span>
      </div>
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">Epoch</div><div class="kpi-value">${record.epochCount}</div></div>
        <div class="kpi"><div class="kpi-label">READY</div><div class="kpi-value">${record.readyFields}/${record.allowlistFieldCount}</div></div>
        <div class="kpi"><div class="kpi-label">Mismatch</div><div class="kpi-value">${record.logicMismatchCount}</div></div>
      </div>
      <div class="toolbar">
        <button type="button" class="btn primary" id="mark-scenario-complete" ${canMark ? '' : 'disabled'}>${record.markedComplete ? '取消签字' : 'Mark Complete（PASS 可签）'}</button>
        <button type="button" class="btn" id="use-as-active-scenario">设为当前测试场景</button>
      </div>
      <div class="cutover-table-wrap">
        <table class="cutover-table">
          <thead><tr><th>字段</th><th>Epoch</th><th>Mismatch</th><th>结果</th></tr></thead>
          <tbody>${fields}</tbody>
        </table>
      </div>
    </div>`;
  }

  function renderScenarioBar(ctx) {
    const tag = ctx.ui.scenarioTag || '';
    const options = CHECKLIST.map(
      (item) => `<option value="${item.tag}" ${tag === item.tag ? 'selected' : ''}>${item.label}</option>`
    ).join('');
    return `<div class="scenario-bar">
      <label>当前测试场景
        <select id="scenario-select"><option value="">— 选择 —</option>${options}</select>
      </label>
      <span class="subtle">${tag ? `Epoch 将计入「${CHECKLIST.find((i) => i.tag === tag)?.label || tag}」` : '未选场景时 Epoch 不计入场景回归'}</span>
    </div>`;
  }

  function renderScenarioTab(ctx) {
    const report = getReport(ctx);
    const summary = report?.summary || {};
    return `${renderScenarioBar(ctx)}
    ${renderVerdict(ctx)}
    <div class="scenario-page">
      <div class="card">
        <div class="card-head">§7.4 场景 Checklist · PASS ${summary.pass || 0}/${summary.total || CHECKLIST.length}</div>
        ${renderChecklist(ctx)}
      </div>
      <div class="card">
        <div class="card-head">场景详情 · 签字 ${summary.markedComplete || 0}/${summary.total || CHECKLIST.length}</div>
        ${renderScenarioDetail(ctx)}
      </div>
    </div>
    <div class="toolbar">
      <button type="button" class="btn" id="export-scenario-json">导出场景报告 JSON</button>
      <button type="button" class="btn" id="export-scenario-csv">导出场景报告 CSV</button>
      <button type="button" class="btn" id="reset-scenario-report">重置场景累计</button>
    </div>
    <div class="banner info">场景 PASS 条件：new 轨已观测 + allowlist 字段在本场景下均无 logic-mismatch。render-mismatch 待 P2。</div>`;
  }

  async function writeScenarioToPage(ctx, tag) {
    await ctx.evalInPage(`(function (tag) {
      if (window.__StateScope__?.setScenarioTag) window.__StateScope__.setScenarioTag(tag);
      else if (tag) localStorage.setItem('stateScopeScenario', tag);
      else localStorage.removeItem('stateScopeScenario');
      return window.__StateScope__?.getScenarioTag?.() || localStorage.getItem('stateScopeScenario') || '';
    })(${JSON.stringify(tag || '')})`);
    ctx.ui.scenarioTag = tag || '';
  }

  function bindScenarioEvents(ctx) {
    document.getElementById('scenario-select')?.addEventListener('change', async (event) => {
      await writeScenarioToPage(ctx, event.target.value);
      ctx.ui.selectedScenarioTag = event.target.value || ctx.ui.selectedScenarioTag;
      ctx.renderApp();
      ctx.bindAppEvents();
    });

    document.querySelectorAll('[data-select-scenario]').forEach((el) => {
      el.addEventListener('click', () => {
        ctx.ui.selectedScenarioTag = el.getAttribute('data-select-scenario');
        ctx.renderApp();
        ctx.bindAppEvents();
      });
    });

    document.getElementById('use-as-active-scenario')?.addEventListener('click', async () => {
      const tag = getSelectedScenario(ctx);
      await writeScenarioToPage(ctx, tag);
      ctx.renderApp();
      ctx.bindAppEvents();
      ctx.showToast(`当前场景：${CHECKLIST.find((i) => i.tag === tag)?.label || tag}`);
    });

    document.getElementById('mark-scenario-complete')?.addEventListener('click', async () => {
      const tag = getSelectedScenario(ctx);
      const record = getReport(ctx)?.scenarios?.[tag];
      const complete = !record?.markedComplete;
      const response = await chrome.runtime.sendMessage({
        type: 'SS_MARK_SCENARIO',
        tabId: ctx.tabId,
        scenarioTag: tag,
        complete
      });
      if (response?.ok) {
        ctx.showToast(complete ? '场景已 Mark Complete' : '已取消签字');
        await ctx.refresh();
      } else {
        ctx.showToast(response?.error || '操作失败');
      }
    });

    document.getElementById('export-scenario-json')?.addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ type: 'SS_EXPORT_SCENARIO_REPORT', tabId: ctx.tabId, format: 'json' });
      if (response?.ok) {
        await ctx.copyText(response.json || '');
      }
    });

    document.getElementById('export-scenario-csv')?.addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ type: 'SS_EXPORT_SCENARIO_REPORT', tabId: ctx.tabId, format: 'csv' });
      if (response?.ok) {
        await ctx.copyText(response.csv || '');
      }
    });

    document.getElementById('reset-scenario-report')?.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'SS_RESET_SCENARIO_REPORT', tabId: ctx.tabId });
      await ctx.refresh();
      ctx.showToast('已重置场景累计');
    });
  }

  function updateNavBadge(ctx) {
    const badge = document.getElementById('scenario-nav-badge');
    if (!badge) {
      return;
    }
    const blocked = getReport(ctx)?.summary?.block || 0;
    if (blocked > 0) {
      badge.textContent = String(blocked);
      badge.className = 'nav-badge nav-badge-bad';
      return;
    }
    const incomplete = getReport(ctx)?.summary?.markedComplete;
    const total = getReport(ctx)?.summary?.total;
    if (total && incomplete === total) {
      badge.textContent = '✓';
      badge.className = 'nav-badge';
      return;
    }
    badge.textContent = '';
    badge.className = 'nav-badge';
  }

  return {
    CHECKLIST,
    renderScenarioTab,
    bindScenarioEvents,
    updateNavBadge,
    getSelectedScenario,
    writeScenarioToPage
  };
})();
