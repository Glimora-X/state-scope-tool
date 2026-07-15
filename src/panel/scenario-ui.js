/* global chrome */
window.StateScopeScenarioUI = (function createScenarioUI() {
  const LEGACY_CHECKLIST = [
    { tag: 'new', label: '新增', checkpoint: '表头 + 明细初始态', order: 0, group: '', signOffMode: 'allowlist', steps: [] },
    { tag: 'edit', label: '编辑', checkpoint: '表头 + 明细初始态', order: 1, group: '', signOffMode: 'allowlist', steps: [] },
    { tag: 'view', label: '查看', checkpoint: '表头 + 明细初始态', order: 2, group: '', signOffMode: 'allowlist', steps: [] },
    { tag: 'copy-new', label: '复制新增', checkpoint: '表头 + 明细初始态', order: 3, group: '', signOffMode: 'allowlist', steps: [] },
    { tag: 'audit-edit', label: '审核中修改', checkpoint: 'Scenario 规则', order: 4, group: '', signOffMode: 'allowlist', steps: [] },
    { tag: 'detail-row-crud', label: '子表增删复制行', checkpoint: 'uuid 下行状态不串', order: 5, group: '', signOffMode: 'allowlist', steps: [] },
    { tag: 'header-linkage', label: '表头改联动字段', checkpoint: '仅受影响字段变化', order: 6, group: '', signOffMode: 'allowlist', steps: [] },
    { tag: 'nested-detail', label: '孙表嵌套', checkpoint: '路径完整', order: 7, group: '', signOffMode: 'allowlist', steps: [] },
    { tag: 'data-grid-edit', label: 'data-grid-edit', checkpoint: '列表/选择态与状态分离', order: 8, group: '', signOffMode: 'allowlist', steps: [] }
  ];

  function resolveChecklist(ctx) {
    const report = getReport(ctx);
    const scenarios = report?.scenarios;
    if (scenarios && Object.keys(scenarios).length) {
      return Object.values(scenarios)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((record) => ({
          tag: record.tag,
          order: record.order ?? 0,
          group: record.group || '',
          label: record.label || record.tag,
          checkpoint: record.checkpoint || '',
          signOffMode: record.signOffMode || 'allowlist',
          steps: record.steps || []
        }));
    }
    // 无上传/无内置包时返回空清单，禁止用 LEGACY 9 项冒充领域验证
    return [];
  }

  function findChecklistItem(ctx, tag) {
    return resolveChecklist(ctx).find((item) => item.tag === tag) || null;
  }

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
      block: 'BLOCK',
      signed: '已签字'
    };
    return map[status] || status;
  }

  function resolveRecordStatus(record) {
    if (record?.markedComplete) {
      return { chip: 'on', label: '已签字' };
    }
    return { chip: statusChip(record?.status), label: statusLabel(record?.status || 'not_started') };
  }

  function getReport(ctx) {
    if (typeof ctx.getScenarioReport === 'function') {
      return ctx.getScenarioReport();
    }
    return ctx.appState?.scenarioReport || null;
  }

  function isCatalogReady(ctx, report) {
    if (typeof ctx.isL3ScenarioReady === 'function' && ctx.isL3ScenarioReady(report)) {
      return true;
    }
    if (report?.catalogVersion === '2026-06-29-l3-v1' && Object.keys(report?.scenarios || {}).length >= 15) {
      return true;
    }
    return !!(report?.boName && report?.catalogVersion && Object.keys(report?.scenarios || {}).length >= 1);
  }

  function getSelectedScenario(ctx) {
    const checklist = resolveChecklist(ctx);
    return ctx.ui.selectedScenarioTag || ctx.ui.scenarioTag || checklist[0]?.tag || '';
  }

  function renderVerdict(ctx) {
    const report = getReport(ctx);
    const active = getSelectedScenario(ctx);
    if (!report) {
      return ctx.renderVerdict({
        status: 'idle',
        headline: '场景回归未开始',
        subline: '加载 L3 场景清单并操作单据'
      });
    }

    const summary = report.summary || {};
    const activeRecord = report.scenarios?.[active];
    if (activeRecord?.status === 'block') {
      return ctx.renderVerdict({
        status: 'error',
        headline: `BLOCK · ${activeRecord.label}`,
        subline: `${activeRecord.blockedFields} 字段升级前后不一致 · 观测轮次 ${activeRecord.epochCount}`
      });
    }
    if (activeRecord?.status === 'pass') {
      const subline =
        activeRecord.signOffMode === 'manual' ?
          'manual 场景已 PASS'
        : `${activeRecord.readyFields}/${activeRecord.allowlistFieldCount} watch 字段就绪`;
      return ctx.renderVerdict({
        status: 'ok',
        headline: `PASS · ${activeRecord.label}`,
        subline
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
    const checklist = resolveChecklist(ctx);
    let lastGroup = null;
    const items = checklist
      .map((item) => {
        const record = report?.scenarios?.[item.tag] || {
          status: 'not_started',
          markedComplete: false,
          epochCount: 0
        };
        const active = selected === item.tag ? ' active' : '';
        const completeMark = record.markedComplete ? ' ✓签字' : '';
        const displayStatus = resolveRecordStatus(record);
        const groupHeader =
          item.group && item.group !== lastGroup ?
            ((lastGroup = item.group), `<div class="scenario-group-head">${ctx.esc(item.group)}</div>`)
          : '';
        return `${groupHeader}<button type="button" class="scenario-item${active}" data-select-scenario="${item.tag}">
        <div class="scenario-item-head">
          <span class="chip ${displayStatus.chip}">${displayStatus.label}</span>
          <strong>${ctx.esc(item.label)}</strong>
          ${item.signOffMode === 'manual' ? '<span class="chip">manual</span>' : ''}
          ${completeMark ? `<span class="subtle">${completeMark}</span>` : ''}
        </div>
        <div class="subtle">${ctx.esc(item.checkpoint)}</div>
        <div class="subtle">观测轮次 ${record.epochCount || 0}${record.logicMismatchCount ? ` · 升级前后不一致 ${record.logicMismatchCount}` : ''}</div>
      </button>`;
      })
      .join('');
    return `<div class="scenario-checklist">${items}</div>`;
  }

  function renderSteps(ctx, record, meta) {
    const steps = record?.steps?.length ? record.steps : meta?.steps || [];
    if (!steps.length) {
      return '';
    }
    const rows = steps
      .map(
        (step) => `<tr>
          <td><code>${ctx.esc(step.id || '—')}</code></td>
          <td>${ctx.esc(step.action || '')}</td>
          <td>${ctx.esc(step.expect || '')}</td>
        </tr>`
      )
      .join('');
    return `<div class="cutover-table-wrap scenario-steps">
      <div class="card-head">操作步骤（${steps.length}）</div>
      <table class="cutover-table">
        <thead><tr><th>ID</th><th>操作</th><th>预期</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  function renderScenarioDetail(ctx) {
    const report = getReport(ctx);
    const tag = getSelectedScenario(ctx);
    const record = report?.scenarios?.[tag];
    const meta = findChecklistItem(ctx, tag);

    if (!record) {
      return '<div class="empty">选择左侧场景</div>';
    }

    const canMark = record.markedComplete || record.status === 'pass' || record.signOffMode === 'manual';
    const markLabel =
      record.markedComplete ?
        '取消签字'
      : record.signOffMode === 'manual' ?
        '签字确认（可不观测直接签）'
      : '签字确认（需先 PASS）';
    const fieldRows = record.fields?.length ?
        record.fields
      : (record.watchFields || []).map((watch) => ({
          path: watch.path,
          stateType: watch.stateType || 'disabled',
          epochCount: 0,
          logicMismatchCount: 0,
          scenarioReady: false,
          blockReason: '尚未观测'
        }));

    const fields =
      fieldRows.length ?
        fieldRows
          .map(
            (field) => `<tr class="${field.logicMismatchCount > 0 ? 'row-bad' : field.scenarioReady ? 'row-ok' : ''}">
          <td><div class="field-name">${ctx.esc(field.path)}</div><div class="field-path">${ctx.esc(field.stateType)}</div></td>
          <td>${field.epochCount}</td>
          <td>${field.logicMismatchCount}</td>
          <td>${field.scenarioReady ? '<span class="chip on">就绪</span>' : `<span class="chip off">${ctx.esc(field.blockReason || '—')}</span>`}</td>
        </tr>`
          )
          .join('')
      : record.signOffMode === 'manual' ?
        `<tr><td colspan="4" class="empty">manual 场景无 watch 字段累计；完成步骤后可直接 Mark Complete。</td></tr>`
      : `<tr><td colspan="4" class="empty">本场景未配置 watch 字段。请确认已上传领域 SSOT 且场景含 assertFields / compareFields。</td></tr>`;

    return `<div>
      <div class="detail-head">
        <div>
          <div class="detail-title">${ctx.esc(meta?.label || record.label || tag)}</div>
          <div class="subtle">${ctx.esc(meta?.checkpoint || record.checkpoint || '')}</div>
        </div>
        <span class="chip ${statusChip(record.status)}">${statusLabel(record.status)}</span>
      </div>
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">观测轮次</div><div class="kpi-value">${record.epochCount}</div></div>
        <div class="kpi"><div class="kpi-label">就绪</div><div class="kpi-value">${record.readyFields}/${record.allowlistFieldCount}</div></div>
        <div class="kpi"><div class="kpi-label">升级前后不一致</div><div class="kpi-value">${record.logicMismatchCount}</div></div>
      </div>
      ${renderSteps(ctx, record, meta)}
      <div class="toolbar">
        <button type="button" class="btn primary" id="mark-scenario-complete" ${canMark ? '' : 'disabled'}>${markLabel}</button>
        <button type="button" class="btn" id="use-as-active-scenario">设为当前测试场景</button>
        <button type="button" class="btn" id="force-sample-epoch" title="单据已在目标态但未触发业务动作时，手动采一帧写入观测轮次">采样当前状态</button>
      </div>
      <div class="banner info" style="margin-top:8px">
        低代码：仅切换场景不会出 Epoch。「新增空白」属初始态——打开空白单后点「采样当前状态」，或改任意字段触发 doDispatch。
      </div>
      <div class="cutover-table-wrap">
        <table class="cutover-table">
          <thead><tr><th>字段</th><th>观测轮次</th><th>升级前后不一致</th><th>结果</th></tr></thead>
          <tbody>${fields}</tbody>
        </table>
      </div>
    </div>`;
  }

  function renderScenarioBar(ctx) {
    const tag = ctx.ui.scenarioTag || '';
    const checklist = resolveChecklist(ctx);
    const options = checklist
      .map((item) => `<option value="${item.tag}" ${tag === item.tag ? 'selected' : ''}>${ctx.esc(item.label)}</option>`)
      .join('');
    const activeLabel = checklist.find((i) => i.tag === tag)?.label || tag;
    const viewing = getSelectedScenario(ctx);
    const viewingLabel = findChecklistItem(ctx, viewing)?.label || viewing;
    const tagMismatch = viewing && tag && viewing !== tag;
    return `<div class="scenario-bar">
      <label>当前测试场景
        <select id="scenario-select"><option value="">— 选择 —</option>${options}</select>
      </label>
      <span class="subtle">${tag ? `观测轮次将计入「${ctx.esc(activeLabel)}」` : '未选场景时观测轮次不计入场景回归'}</span>
      ${tagMismatch ? `<span class="chip off">左侧查看「${ctx.esc(viewingLabel)}」但未设为当前场景</span>` : ''}
    </div>`;
  }

  function renderScenarioTab(ctx) {
    const report = getReport(ctx);
    const summary = report?.summary || {};
    const checklist = resolveChecklist(ctx);
    const boName = report?.boName || ctx.ui?.pageSettings?.pageMeta?.boName || '当前 BO';
    const ready = isCatalogReady(ctx, report);
    const catalogLine = ready ?
        `${report.boName || '—'} · ${ctx.esc(report.catalogTitle || '场景包')} · v${ctx.esc(report.catalogVersion)} · epoch ${ctx.esc(report.catalogEpoch || '—')} · ${ctx.esc(report.catalogSource || '—')} · ${Object.keys(report.scenarios || {}).length} 项`
      : `${ctx.esc(boName)} · 未加载场景包 · 等待领域自注册或上传 SSOT`;
    const catalogBanner =
      ready ?
        ''
      : `<div class="banner warn">
        <strong>需要场景清单</strong>：优先靠领域 <code>publishStateScopeForDebug</code> 自注册；也可上传业务仓 <code>*.scenarios.v1.json</code>。
        有自注册时会覆盖本地旧上传（同源 <code>catalogEpoch</code> 亦切换为 <code>window-registry</code>）。
        仅销货单 GoodsIssue 仍可点「加载内置场景」。
      </div>`;
    const emptyHint =
      !ready && !checklist.length ?
        `<div class="empty">尚无场景清单。点下方「上传领域 SSOT」选择业务仓 JSON。</div>`
      : '';
    return `${renderScenarioBar(ctx)}
    ${catalogBanner}
    ${renderVerdict(ctx)}
    <div class="scenario-page">
      <div class="card">
        <div class="card-head">场景 Checklist · PASS ${summary.pass || 0}/${summary.total || checklist.length}</div>
        <div class="subtle scenario-catalog-meta">${catalogLine}</div>
        ${emptyHint || renderChecklist(ctx)}
      </div>
      <div class="card">
        <div class="card-head">场景详情 · 签字 ${summary.markedComplete || 0}/${summary.total || checklist.length}</div>
        ${ready ? renderScenarioDetail(ctx) : '<div class="empty">上传 SSOT 后显示场景步骤与签字</div>'}
      </div>
    </div>
    <div class="toolbar">
      <button type="button" class="btn primary" id="import-scenario-catalog-btn">上传领域 SSOT</button>
      <input type="file" id="import-scenario-catalog" accept=".json,application/json" hidden />
      <button type="button" class="btn" id="reload-scenario-catalog">加载内置场景（仅 GoodsIssue）</button>
      <button type="button" class="btn" id="export-scenario-json">导出场景报告 JSON</button>
      <button type="button" class="btn" id="export-scenario-csv">导出场景报告 CSV</button>
      <button type="button" class="btn" id="reset-scenario-report">重置场景累计</button>
    </div>
    <div class="banner info">领域 SSOT 直接可用（id/setup/assertFields）。通过条件：升级后（影子）已观测 + watch 字段无升级前后不一致。</div>`;
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
      await ctx.refresh?.({ force: true });
    });

    document.querySelectorAll('[data-select-scenario]').forEach((el) => {
      el.addEventListener('click', async () => {
        const tag = el.getAttribute('data-select-scenario');
        ctx.ui.selectedScenarioTag = tag;
        await writeScenarioToPage(ctx, tag);
        const label = findChecklistItem(ctx, tag)?.label || tag;
        ctx.showToast(`当前场景：${label}`);
        const meta = findChecklistItem(ctx, tag);
        const blankSetup =
          /空白|打开单据|不录入/.test(`${meta?.checkpoint || ''} ${meta?.label || ''}`) &&
          !/明细|选单|生单|保存|审核/.test(`${meta?.checkpoint || ''} ${meta?.label || ''}`);
        // 空白初始态：仅选场景不会触发 doDispatch → 自动采一帧，否则时间线空白
        if (blankSetup) {
          const sample = await ctx.evalInPage(`(function () {
            var ss = window.__StateScope__;
            if (!ss) { try { ss = window.top && window.top.__StateScope__; } catch (e) {} }
            if (!ss) return { ok: false, error: 'injector 未就绪' };
            if (ss.resampleBootstrap) {
              return ss.resampleBootstrap();
            }
            if (ss.forceLowcodeSample) {
              return ss.forceLowcodeSample('scenario-blank-setup');
            }
            return { ok: false, error: '无采样 API' };
          })()`);
          const result = sample?.result || sample;
          if (result?.ok) {
            ctx.showToast('已触发空白初始态采样，约 0.5s 后看时间线');
            await new Promise((resolve) => setTimeout(resolve, 700));
          } else if (result?.error) {
            ctx.showToast(result.error);
          }
        }
        await ctx.refresh?.({ force: true });
      });
    });

    document.getElementById('use-as-active-scenario')?.addEventListener('click', async () => {
      const tag = getSelectedScenario(ctx);
      await writeScenarioToPage(ctx, tag);
      const label = findChecklistItem(ctx, tag)?.label || tag;
      ctx.showToast(`当前场景：${label}`);
      await ctx.refresh?.({ force: true });
    });

    document.getElementById('force-sample-epoch')?.addEventListener('click', async () => {
      const tag = getSelectedScenario(ctx);
      if (tag) {
        await writeScenarioToPage(ctx, tag);
      }
      const sample = await ctx.evalInPage(`(function () {
        var ss = window.__StateScope__;
        if (!ss) {
          try { ss = window.top && window.top.__StateScope__; } catch (e) {}
        }
        if (!ss || !ss.forceLowcodeSample) {
          return { ok: false, error: 'injector 未就绪' };
        }
        return ss.forceLowcodeSample('manual-sample');
      })()`);
      const result = sample?.result || sample;
      if (result?.ok) {
        ctx.showToast('已采样当前状态，写入观测轮次');
        await ctx.refresh?.({ force: true });
      } else {
        ctx.showToast(result?.error || sample?.error || '采样失败');
      }
    });

    document.getElementById('mark-scenario-complete')?.addEventListener('click', async () => {
      const tag = getSelectedScenario(ctx);
      if (!tag) {
        ctx.showToast('请先选择左侧场景');
        return;
      }
      const record = getReport(ctx)?.scenarios?.[tag];
      const complete = !record?.markedComplete;

      // 签字前确保 SW 有 catalog（避免 Panel 已显示场景但后台报「未知场景」）
      if (ctx.syncScenarioCatalog) {
        await ctx.syncScenarioCatalog();
      }

      let response = await chrome.runtime.sendMessage({
        type: 'SS_MARK_SCENARIO',
        tabId: ctx.tabId,
        scenarioTag: tag,
        complete
      });

      if (!response?.ok && response?.needsUpload && ctx.ui?.scenarioCatalog) {
        await ctx.syncScenarioCatalog({ catalog: ctx.ui.scenarioCatalog });
        response = await chrome.runtime.sendMessage({
          type: 'SS_MARK_SCENARIO',
          tabId: ctx.tabId,
          scenarioTag: tag,
          complete
        });
      }

      if (response?.ok) {
        ctx.applyScenarioMarkLocally?.(tag, response.record, response.summary);
        ctx.showToast(complete ? '已签字确认本场景通过' : '已取消签字');
        await ctx.refresh({ force: true });
      } else {
        ctx.showToast(response?.error || '操作失败');
      }
    });

    document.getElementById('reload-scenario-catalog')?.addEventListener('click', async () => {
      if (!ctx.syncScenarioCatalog) {
        ctx.showToast('Panel 未接入场景同步');
        return;
      }
      const result = await ctx.syncScenarioCatalog({ force: true });
      if (result?.ok) {
        ctx.showToast(`已加载 ${result.scenarioCount || 0} 个场景`);
      } else if (result?.needsUpload) {
        ctx.showToast(result.error || '请上传领域 SSOT');
        document.getElementById('import-scenario-catalog')?.click();
      } else {
        ctx.showToast(result?.error || '场景清单加载失败');
      }
      await ctx.refresh({ force: true });
    });

    document.getElementById('import-scenario-catalog-btn')?.addEventListener('click', () => {
      document.getElementById('import-scenario-catalog')?.click();
    });

    document.getElementById('import-scenario-catalog')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || !ctx.syncScenarioCatalog) {
        return;
      }
      try {
        const rawText = (await file.text()).replace(/^\uFEFF/, '');
        const catalog = JSON.parse(rawText);
        if (!catalog?.scenarios?.length) {
          ctx.showToast(
            catalog?.fields?.length ?
              '这是 allowlist 文件，请到「设置」上传 allowlist；场景包需含 scenarios 数组'
            : '无效 SSOT：缺少 scenarios 数组'
          );
          return;
        }
        if (!catalog.boName) {
          ctx.showToast('无效 SSOT：缺少 boName 字段');
          return;
        }
        const result = await ctx.syncScenarioCatalog({ force: true, catalog });
        ctx.showToast(
          result?.ok ?
            `已导入 ${result.scenarioCount || catalog.scenarios?.length || 0} 个场景（${catalog.boName}）`
          : result?.error || result?.reason || '导入失败'
        );
        await ctx.refresh({ force: true });
      } catch (error) {
        ctx.showToast(`JSON 解析失败：${error.message}`);
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
      const response = await chrome.runtime.sendMessage({
        type: 'SS_RESET_SCENARIO_REPORT',
        tabId: ctx.tabId
      });
      if (response?.ok && response.scenarioReport && ctx.appState) {
        ctx.appState.scenarioReport = response.scenarioReport;
      }
      // 强制下一轮用新水位重算
      if (typeof ctx.clearScenarioFromEpochsKey === 'function') {
        ctx.clearScenarioFromEpochsKey();
      }
      await ctx.refresh?.({ force: true });
      ctx.showToast('已重置场景累计（历史轮次仍保留，仅之后操作重新计入）');
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
    LEGACY_CHECKLIST,
    resolveChecklist,
    renderScenarioTab,
    bindScenarioEvents,
    updateNavBadge,
    getSelectedScenario,
    writeScenarioToPage
  };
})();
