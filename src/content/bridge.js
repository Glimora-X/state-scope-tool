(function relayStateScopeMessages() {
  if (window.__stateScopeRelayInstalled__) {
    return;
  }
  window.__stateScopeRelayInstalled__ = true;

  let relayOpen = true;
  let relayWarned = false;

  function markRelayBroken(type, error) {
    relayOpen = false;
    try {
      window.__StateScopeRelayBroken__ = true;
    } catch {
      // ignore
    }
    notifyRelayResult(type, false, error || 'relay disconnected');
    if (!relayWarned) {
      relayWarned = true;
      console.warn(
        '[StateScope] extension relay disconnected — 数据仍缓存在页面，请 chrome://extensions 重载扩展后 F5 单据页。'
      );
    }
  }

  function notifyRelayResult(type, ok, error) {
    try {
      window.postMessage(
        {
          channel: 'StateScopeExtensionAck',
          ok,
          type,
          error: error || ''
        },
        '*'
      );
    } catch {
      // ignore
    }
  }

  function canUseExtensionRuntime() {
    if (!relayOpen) {
      return false;
    }
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || data.channel !== 'StateScopeExtension') {
      return;
    }

    if (!canUseExtensionRuntime()) {
      markRelayBroken(data.type, 'extension context invalidated');
      return;
    }

    try {
      chrome.runtime.sendMessage(
        {
          type: data.type,
          payload: data.payload
        },
        () => {
          const err = chrome.runtime.lastError;
          if (err) {
            markRelayBroken(data.type, err.message);
            return;
          }
          relayOpen = true;
          relayWarned = false;
          try {
            window.__StateScopeRelayBroken__ = false;
          } catch {
            // ignore
          }
          notifyRelayResult(data.type, true, '');
        }
      );
    } catch (error) {
      markRelayBroken(data.type, error?.message || 'extension context invalidated');
    }
  });
})();

(function loadDefaultAllowlist() {
  const ALL_FILES = ['OutsourceIssue.v1.json', 'GoodsIssue.v1.json'];
  let loading = false;
  const deliveredBoNames = new Set();

  function guessBoNameFromUrl() {
    try {
      const href = `${location.hash || ''}${location.search || ''}`;
      const pageParamsMatch = (location.search || href).match(/pageParams=([^&]+)/);
      if (pageParamsMatch?.[1]) {
        try {
          const params = JSON.parse(decodeURIComponent(pageParamsMatch[1]));
          const groupId = params?.routeParams?.groupId || params?.menuInfo?.routeParams?.groupId;
          if (groupId) {
            return String(groupId);
          }
        } catch {
          // ignore
        }
      }
      if (/outsourceIssue/i.test(href)) {
        return 'OutsourceIssue';
      }
      if (/goodsIssue/i.test(href)) {
        return 'GoodsIssue';
      }
      if (/mpManufactureOrder/i.test(href)) {
        return 'MpManufactureOrder';
      }
    } catch {
      // ignore
    }
    return '';
  }

  function deliverAllowlistToPage(config) {
    if (!config?.boName || deliveredBoNames.has(config.boName)) {
      return;
    }
    deliveredBoNames.add(config.boName);

    // 仅把「当前路由匹配」的 allowlist 写入 DOM（injector 启动时读一次）
    const routeBo = guessBoNameFromUrl();
    if (!routeBo || routeBo === config.boName) {
      try {
        document.documentElement.setAttribute('data-state-scope-allowlist', JSON.stringify(config));
      } catch {
        // ignore
      }
    }

    window.postMessage({ channel: 'StateScopeAllowlist', config }, '*');
  }

  function orderedCandidates() {
    const bo = guessBoNameFromUrl();
    if (bo) {
      return [`${bo}.v1.json`, ...ALL_FILES.filter((f) => f !== `${bo}.v1.json`)];
    }
    return ALL_FILES;
  }

  async function loadAllowlistFiles() {
    if (loading) {
      return false;
    }
    if (localStorage.getItem('stateScopeAutoAllowlist') === 'false') {
      return false;
    }
    loading = true;
    try {
      if (!chrome.runtime?.id) {
        return false;
      }
      let any = false;
      for (const fileName of orderedCandidates()) {
        try {
          const url = chrome.runtime.getURL(`allowlists/${fileName}`);
          const response = await fetch(url);
          if (!response.ok) {
            continue;
          }
          const config = await response.json();
          if (!config?.boName || !config?.fields?.length) {
            continue;
          }
          deliverAllowlistToPage(config);
          any = true;
        } catch {
          // try next
        }
      }
      return any;
    } finally {
      loading = false;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    if (event.data?.channel === 'StateScopeInternal' && event.data.type === 'requestAllowlist') {
      loadAllowlistFiles();
    }
    if (event.data?.channel === 'StateScopeInternal' && event.data.type === 'allowlistAck') {
      document.documentElement.removeAttribute('data-state-scope-allowlist');
    }
  });

  loadAllowlistFiles();
})();

(function injectStateScope() {
  if (window.__stateScopeBridgeInjected__) {
    return;
  }
  window.__stateScopeBridgeInjected__ = true;

  function shouldInjectMainWorld() {
    try {
      return localStorage.getItem('bizDebug') === 'true' || window.bizDebug === true;
    } catch {
      return false;
    }
  }

  if (!shouldInjectMainWorld()) {
    return;
  }

  if (!chrome.runtime?.id) {
    return;
  }

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('dist/injector.js');
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
})();
