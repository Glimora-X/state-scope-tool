(function relayStateScopeMessages() {
  if (window.__stateScopeRelayInstalled__) {
    return;
  }
  window.__stateScopeRelayInstalled__ = true;

  var RELAY_ALLOWED_TYPES = {
    SS_EPOCH: true,
    SS_RUNTIME: true
  };

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
        window.location.origin
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

    if (!RELAY_ALLOWED_TYPES[data.type]) {
      console.warn('[StateScope] relay blocked unknown type:', data.type);
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
