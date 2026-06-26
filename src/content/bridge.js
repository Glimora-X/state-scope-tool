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
  const candidates = ['GoodsIssue.v1.example.json'];

  async function postAllowlist(fileName) {
    try {
      const url = chrome.runtime.getURL(`allowlists/${fileName}`);
      const response = await fetch(url);
      if (!response.ok) {
        return false;
      }
      const config = await response.json();
      window.postMessage({ channel: 'StateScopeAllowlist', config }, '*');
      return true;
    } catch {
      return false;
    }
  }

  window.addEventListener('StateScopeAutoAllowlistOk', () => {
    (async () => {
      for (const fileName of candidates) {
        if (await postAllowlist(fileName)) {
          break;
        }
      }
    })();
  });

  const gate = document.createElement('script');
  gate.textContent = `(function () {
    if (localStorage.getItem('stateScopeAutoAllowlist') === 'false') {
      return;
    }
    window.dispatchEvent(new CustomEvent('StateScopeAutoAllowlistOk'));
  })();`;
  (document.documentElement || document.head).appendChild(gate);
  gate.remove();
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
