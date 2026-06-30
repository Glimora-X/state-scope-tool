(function relayStateScopeMessages() {
  if (window.__stateScopeRelayInstalled__) {
    return;
  }
  window.__stateScopeRelayInstalled__ = true;

  function notifyRelayResult(type, ok, error) {
    window.postMessage(
      {
        channel: 'StateScopeExtensionAck',
        ok,
        type,
        error: error || ''
      },
      '*'
    );
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || data.channel !== 'StateScopeExtension') {
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
            console.warn(
              `[StateScope] extension relay failed (${data.type}): ${err.message}. 请刷新单据页 (F5) 后重试。`
            );
            notifyRelayResult(data.type, false, err.message);
            return;
          }
          notifyRelayResult(data.type, true, '');
        }
      );
    } catch (error) {
      console.warn('[StateScope] extension context invalidated — 请刷新单据页 (F5)', error);
      notifyRelayResult(data.type, false, error?.message || 'extension context invalidated');
    }
  });
})();

(function loadDefaultAllowlist() {
  const candidates = ['GoodsIssue.v1.json', 'GoodsIssue.v1.example.json'];
  let loading = false;

  /** DOM 属性：跨 content script ↔ MAIN world，不受 CSP 内联脚本限制 */
  function deliverAllowlistToPage(config) {
    try {
      document.documentElement.setAttribute('data-state-scope-allowlist', JSON.stringify(config));
    } catch (error) {
      console.warn('[StateScope] allowlist DOM deliver failed', error);
    }

    const script = document.createElement('script');
    script.textContent = `(function () {
      var config = ${JSON.stringify(config)};
      if (localStorage.getItem('stateScopeAutoAllowlist') === 'false') {
        return;
      }
      if (window.__StateScope__ && typeof window.__StateScope__.applyAllowlistConfig === 'function') {
        window.__StateScope__.applyAllowlistConfig(config);
        return;
      }
      window.__StateScopePendingAllowlists__ = window.__StateScopePendingAllowlists__ || [];
      var exists = window.__StateScopePendingAllowlists__.some(function (item) {
        return item && item.boName === config.boName && item.version === config.version;
      });
      if (!exists) {
        window.__StateScopePendingAllowlists__.push(config);
      }
    })();`;
    (document.documentElement || document.head).appendChild(script);
    script.remove();

    window.postMessage({ channel: 'StateScopeAllowlist', config }, '*');
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
      for (const fileName of candidates) {
        try {
          const url = chrome.runtime.getURL(`allowlists/${fileName}`);
          const response = await fetch(url);
          if (!response.ok) {
            console.warn(`[StateScope] allowlist fetch failed: ${fileName} (${response.status})`);
            continue;
          }
          const config = await response.json();
          if (!config?.boName || !config?.fields?.length) {
            console.warn(`[StateScope] allowlist invalid: ${fileName}`);
            continue;
          }
          deliverAllowlistToPage(config);
          console.info(
            `[StateScope] allowlist delivered: ${config.boName} v${config.version || '?'} (${config.fields.length} fields)`
          );
          return true;
        } catch (error) {
          console.warn(`[StateScope] allowlist load error: ${fileName}`, error);
        }
      }
      return false;
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
  setTimeout(() => loadAllowlistFiles(), 800);
  setTimeout(() => loadAllowlistFiles(), 2500);
  setTimeout(() => loadAllowlistFiles(), 6000);
})();

(function injectStateScope() {
  if (window.__stateScopeBridgeInjected__) {
    return;
  }
  window.__stateScopeBridgeInjected__ = true;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('dist/injector.js');
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
})();
