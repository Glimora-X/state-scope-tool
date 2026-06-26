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
