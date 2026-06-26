/* global chrome */
window.StateScopeIssuesUI = (function createIssuesUI() {
  const SCENARIOS = [
    { tag: 'new', label: '新增' },
    { tag: 'edit', label: '编辑' },
    { tag: 'view', label: '查看' },
    { tag: 'copy-new', label: '复制新增' },
    { tag: 'audit-edit', label: '审核中修改' },
    { tag: 'detail-row-crud', label: '子表增删复制行' },
    { tag: 'header-linkage', label: '表头改联动字段' },
    { tag: 'nested-detail', label: '孙表嵌套' },
    { tag: 'data-grid-edit', label: 'data-grid-edit' },
    { tag: 'manual', label: '手动标记' }
  ];

  function scenarioLabel(tag) {
    return SCENARIOS.find((item) => item.tag === tag)?.label || tag || '—';
  }

  function renderScenarioOptions(selected) {
    return `<option value="">— 选择场景 —</option>${SCENARIOS.map(
      (item) => `<option value="${item.tag}" ${selected === item.tag ? 'selected' : ''}>${item.label}</option>`
    ).join('')}`;
  }

  function renderScenarioBar(ctx) {
    const tag = ctx.ui.scenarioTag || '';
    return `<div class="scenario-bar">
      <label>当前场景
        <select id="scenario-select">${renderScenarioOptions(tag)}</select>
      </label>
      <span class="subtle">${tag ? `已选：${scenarioLabel(tag)}` : '未选场景时不会自动采集 Issue'}</span>
    </div>`;
  }

  function filterIssues(issues, ui) {
    return (issues || []).filter((issue) => {
      if (ui.issueStatusFilter && issue.status !== ui.issueStatusFilter) {
        return false;
      }
      if (ui.issueSyncFilter === 'pending' && issue.jira?.syncStatus !== 'pending' && issue.jira?.syncStatus !== 'failed' && issue.jira?.syncStatus !== 'stale') {
        return false;
      }
      if (ui.issueSyncFilter === 'synced' && issue.jira?.syncStatus !== 'synced') {
        return false;
      }
      return true;
    });
  }

  function renderIssuesTab(ctx) {
    const issues = filterIssues(ctx.appState?.issues || [], ctx.ui);
    const openCount = (ctx.appState?.issues || []).filter((item) => item.status === 'open').length;
    const pendingSync = (ctx.appState?.issues || []).filter(
      (item) => !item.jira?.key || item.jira?.syncStatus === 'pending' || item.jira?.syncStatus === 'failed' || item.jira?.syncStatus === 'stale'
    ).length;

    const rows =
      issues.length ?
        issues
          .map((issue) => {
            const checked = ctx.ui.selectedIssueFps?.has(issue.fingerprint) ? ' checked' : '';
            const jiraCell =
              issue.jira?.key ?
                `<a href="${ctx.esc(issue.jira.url || '#')}" target="_blank" rel="noopener">${ctx.esc(issue.jira.key)}</a>`
              : `<span class="chip off">${ctx.esc(issue.jira?.syncStatus || 'pending')}</span>`;
            return `<tr>
              <td><input type="checkbox" class="issue-select" data-fp="${ctx.esc(issue.fingerprint)}"${checked} /></td>
              <td>
                <div class="field-name">${ctx.esc(issue.fieldPath)}</div>
                <div class="field-path">${ctx.esc(issue.stateType)} · ${ctx.esc(issue.issueType)}</div>
              </td>
              <td>${ctx.esc(scenarioLabel(issue.scenarioTag))}</td>
              <td><span class="chip">${ctx.esc(issue.status)}</span></td>
              <td>${issue.occurrenceCount || 1}</td>
              <td>${jiraCell}</td>
              <td>
                <button type="button" class="btn-mini issue-sync-one" data-fp="${ctx.esc(issue.fingerprint)}">同步</button>
                <button type="button" class="btn-mini issue-close" data-fp="${ctx.esc(issue.fingerprint)}">关闭</button>
              </td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="7" class="empty">尚无 Issue。请选择场景并触发 logic-mismatch，或从概览「需要关注」升 Issue。</td></tr>`;

    return `${renderScenarioBar(ctx)}
    <div class="issues-page">
      <div class="card">
        <div class="card-head">Issues · Open ${openCount} · 待同步 ${pendingSync}</div>
        <div class="toolbar">
          <label>状态
            <select id="issue-status-filter">
              <option value="">全部</option>
              <option value="open" ${ctx.ui.issueStatusFilter === 'open' ? 'selected' : ''}>open</option>
              <option value="triaging" ${ctx.ui.issueStatusFilter === 'triaging' ? 'selected' : ''}>triaging</option>
              <option value="in_progress" ${ctx.ui.issueStatusFilter === 'in_progress' ? 'selected' : ''}>in_progress</option>
              <option value="verified" ${ctx.ui.issueStatusFilter === 'verified' ? 'selected' : ''}>verified</option>
              <option value="closed" ${ctx.ui.issueStatusFilter === 'closed' ? 'selected' : ''}>closed</option>
            </select>
          </label>
          <label>Jira
            <select id="issue-sync-filter">
              <option value="">全部</option>
              <option value="pending" ${ctx.ui.issueSyncFilter === 'pending' ? 'selected' : ''}>待同步/失败</option>
              <option value="synced" ${ctx.ui.issueSyncFilter === 'synced' ? 'selected' : ''}>已同步</option>
            </select>
          </label>
          <button type="button" class="btn" id="issue-select-all">全选</button>
          <button type="button" class="btn" id="issue-batch-sync">批量同步 Jira</button>
          <button type="button" class="btn" id="issue-export-md">导出 Markdown</button>
        </div>
        <div class="cutover-table-wrap">
          <table class="cutover-table issues-table">
            <thead>
              <tr>
                <th></th>
                <th>字段</th>
                <th>场景</th>
                <th>状态</th>
                <th>次数</th>
                <th>Jira</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
      <div class="banner info">Issue 存本地（chrome.storage）。Jira 为副本；token 仅存扩展本地，不会写入导出 JSON。</div>
    </div>`;
  }

  function renderJiraSettings(ctx) {
    const jira = ctx.appState?.settings?.jira || {};
    const tokenMask = jira.hasToken ? '••••••••••••' : '未配置';
    return `<div class="card">
      <h3>Jira 同步</h3>
      <div class="settings-row">
        <div><div>启用 Jira</div><div class="subtle">开启后才可同步（仍存本地 Issue）</div></div>
        <span class="chip ${jira.enabled ? 'on' : 'off'}">${jira.enabled ? '已启用' : '未启用'}</span>
      </div>
      <div class="settings-row">
        <div><div>自动同步</div><div class="subtle">新 Issue upsert 后自动创建/更新 Jira（默认关）</div></div>
        <span class="chip ${jira.autoSync ? 'on' : 'off'}">${jira.autoSync ? '开启' : '关闭'}</span>
      </div>
      <div class="settings-form">
        <label>Base URL<input id="jira-base-url" type="url" placeholder="https://jira.example.com" value="${ctx.esc(jira.baseUrl || '')}" /></label>
        <label>Project Key<input id="jira-project-key" type="text" placeholder="PROJ" value="${ctx.esc(jira.projectKey || '')}" /></label>
        <label>Issue Type<input id="jira-issue-type" type="text" value="${ctx.esc(jira.issueType || 'Bug')}" /></label>
        <label>Email<input id="jira-email" type="email" placeholder="you@company.com" value="${ctx.esc(jira.email || '')}" /></label>
        <label>API Token（仅本地存储）<input id="jira-api-token" type="password" placeholder="${tokenMask}" autocomplete="new-password" /></label>
        <label>Labels<input id="jira-labels" type="text" value="${ctx.esc((jira.labels || []).join(', '))}" /></label>
        <label class="checkbox-row"><input id="jira-enabled" type="checkbox" ${jira.enabled ? 'checked' : ''} /> 启用 Jira 集成</label>
        <label class="checkbox-row"><input id="jira-auto-sync" type="checkbox" ${jira.autoSync ? 'checked' : ''} /> 自动同步到 Jira</label>
        <label class="checkbox-row"><input id="auto-collect-issues" type="checkbox" ${ctx.appState?.settings?.autoCollectIssues !== false ? 'checked' : ''} /> 自动从 Epoch 采集 Issue（需场景）</label>
      </div>
      <div class="settings-actions">
        <button type="button" class="btn primary" id="save-jira-settings">保存 Jira 设置</button>
        <button type="button" class="btn" id="test-jira-settings">测试连接</button>
        <button type="button" class="btn" id="clear-jira-token">清除 Token</button>
      </div>
    </div>`;
  }

  async function readScenarioFromPage(ctx) {
    const response = await ctx.evalInPage(`({
      scenarioTag: window.__StateScope__?.getScenarioTag?.() || localStorage.getItem('stateScopeScenario') || ''
    })`);
    if (response.ok) {
      ctx.ui.scenarioTag = response.result.scenarioTag || '';
    }
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

  async function promoteAnomaly(ctx, anomaly) {
    if (!ctx.ui.scenarioTag) {
      ctx.showToast('请先选择当前场景');
      return;
    }
    const epoch = ctx.getSelectedEpoch();
    if (!epoch) {
      ctx.showToast('无 Epoch');
      return;
    }
    const response = await chrome.runtime.sendMessage({
      type: 'SS_PROMOTE_ISSUE',
      tabId: ctx.tabId,
      epochId: epoch.id,
      anomaly,
      scenarioTag: ctx.ui.scenarioTag,
      autoSyncJira: !!ctx.appState?.settings?.jira?.autoSync
    });
    if (response?.ok) {
      ctx.showToast('已升 Issue');
      await ctx.refresh();
    } else {
      ctx.showToast(response?.error || '升 Issue 失败');
    }
  }

  function bindIssuesEvents(ctx) {
    document.getElementById('scenario-select')?.addEventListener('change', async (event) => {
      await writeScenarioToPage(ctx, event.target.value);
      ctx.renderApp();
      ctx.bindAppEvents();
    });

    document.getElementById('issue-status-filter')?.addEventListener('change', (event) => {
      ctx.ui.issueStatusFilter = event.target.value || '';
      ctx.renderApp();
      ctx.bindAppEvents();
    });

    document.getElementById('issue-sync-filter')?.addEventListener('change', (event) => {
      ctx.ui.issueSyncFilter = event.target.value || '';
      ctx.renderApp();
      ctx.bindAppEvents();
    });

    document.querySelectorAll('.issue-select').forEach((el) => {
      el.addEventListener('change', () => {
        if (!ctx.ui.selectedIssueFps) {
          ctx.ui.selectedIssueFps = new Set();
        }
        const fp = el.getAttribute('data-fp');
        if (el.checked) {
          ctx.ui.selectedIssueFps.add(fp);
        } else {
          ctx.ui.selectedIssueFps.delete(fp);
        }
      });
    });

    document.getElementById('issue-select-all')?.addEventListener('click', () => {
      const issues = filterIssues(ctx.appState?.issues || [], ctx.ui);
      ctx.ui.selectedIssueFps = new Set(issues.map((item) => item.fingerprint));
      ctx.renderApp();
      ctx.bindAppEvents();
    });

    document.getElementById('issue-batch-sync')?.addEventListener('click', async () => {
      const fps = [...(ctx.ui.selectedIssueFps || [])];
      if (!fps.length) {
        ctx.showToast('请先勾选 Issue');
        return;
      }
      const response = await chrome.runtime.sendMessage({
        type: 'SS_BATCH_SYNC_JIRA',
        tabId: ctx.tabId,
        fingerprints: fps
      });
      if (response?.ok) {
        const failed = (response.results || []).filter((item) => !item.ok).length;
        ctx.showToast(failed ? `同步完成，${failed} 条失败` : '批量同步完成');
        await ctx.refresh();
      } else {
        ctx.showToast(response?.error || '同步失败');
      }
    });

    document.getElementById('issue-export-md')?.addEventListener('click', async () => {
      const fps = [...(ctx.ui.selectedIssueFps || [])];
      const response = await chrome.runtime.sendMessage({
        type: 'SS_EXPORT_ISSUES_MD',
        tabId: ctx.tabId,
        fingerprints: fps.length ? fps : undefined
      });
      if (response?.ok) {
        await ctx.copyText(response.markdown || '');
      }
    });

    document.querySelectorAll('.issue-sync-one').forEach((el) => {
      el.addEventListener('click', async () => {
        const fp = el.getAttribute('data-fp');
        const response = await chrome.runtime.sendMessage({
          type: 'SS_BATCH_SYNC_JIRA',
          tabId: ctx.tabId,
          fingerprints: [fp]
        });
        if (response?.ok) {
          ctx.showToast('同步完成');
          await ctx.refresh();
        } else {
          ctx.showToast(response?.error || '同步失败');
        }
      });
    });

    document.querySelectorAll('.issue-close').forEach((el) => {
      el.addEventListener('click', async () => {
        const fp = el.getAttribute('data-fp');
        await chrome.runtime.sendMessage({
          type: 'SS_UPDATE_ISSUE',
          tabId: ctx.tabId,
          fingerprint: fp,
          patch: { status: 'closed', statusNote: 'closed from panel' }
        });
        await ctx.refresh();
      });
    });

    document.querySelectorAll('[data-promote-issue]').forEach((el) => {
      el.addEventListener('click', async (event) => {
        event.stopPropagation();
        const anomaly = {
          path: el.getAttribute('data-path'),
          severity: el.getAttribute('data-severity'),
          message: el.getAttribute('data-message')
        };
        await promoteAnomaly(ctx, anomaly);
      });
    });
  }

  function bindJiraSettingsEvents(ctx) {
    document.getElementById('save-jira-settings')?.addEventListener('click', async () => {
      const labels = document.getElementById('jira-labels')?.value || '';
      const settings = {
        autoCollectIssues: document.getElementById('auto-collect-issues')?.checked !== false,
        jira: {
          enabled: document.getElementById('jira-enabled')?.checked === true,
          autoSync: document.getElementById('jira-auto-sync')?.checked === true,
          baseUrl: document.getElementById('jira-base-url')?.value?.trim() || '',
          projectKey: document.getElementById('jira-project-key')?.value?.trim() || '',
          issueType: document.getElementById('jira-issue-type')?.value?.trim() || 'Bug',
          email: document.getElementById('jira-email')?.value?.trim() || '',
          labels: labels.split(',').map((item) => item.trim()).filter(Boolean)
        }
      };
      const saveSettings = await chrome.runtime.sendMessage({
        type: 'SS_SAVE_SETTINGS',
        tabId: ctx.tabId,
        settings
      });
      const token = document.getElementById('jira-api-token')?.value?.trim();
      if (token) {
        await chrome.runtime.sendMessage({ type: 'SS_SAVE_JIRA_TOKEN', tabId: ctx.tabId, apiToken: token });
      }
      ctx.ui.settingsMessage = saveSettings?.ok ? 'Jira 设置已保存（Token 单独存储，不会导出）' : '保存失败';
      document.getElementById('jira-api-token').value = '';
      await ctx.refresh();
    });

    document.getElementById('test-jira-settings')?.addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ type: 'SS_TEST_JIRA', tabId: ctx.tabId });
      ctx.ui.settingsMessage = response?.ok ? 'Jira 连接成功' : `连接失败：${response?.error || '未知'}`;
      ctx.renderApp();
      ctx.bindAppEvents();
    });

    document.getElementById('clear-jira-token')?.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'SS_CLEAR_JIRA_TOKEN', tabId: ctx.tabId });
      ctx.ui.settingsMessage = '已清除 Jira Token';
      await ctx.refresh();
    });
  }

  function enhanceAnomalyRow(ctx, item) {
    return `<button type="button" class="btn-mini issue-promote-btn" data-promote-issue data-path="${ctx.esc(item.path)}" data-severity="${ctx.esc(item.severity)}" data-message="${ctx.esc(item.message)}">升 Issue</button>`;
  }

  return {
    SCENARIOS,
    scenarioLabel,
    renderIssuesTab,
    renderJiraSettings,
    readScenarioFromPage,
    bindIssuesEvents,
    bindJiraSettingsEvents,
    enhanceAnomalyRow
  };
})();
