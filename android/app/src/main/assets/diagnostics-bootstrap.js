(function () {
  'use strict';
  if (window !== window.top || location.href !== 'https://appassets.androidplatform.net/index.html') return;
  if (window.__disposeAndroidDiagnostics) window.__disposeAndroidDiagnostics();
  var nonce = '__DIAGNOSTIC_NONCE__';
  var port = null;
  var clickEndpoint = null;
  var clickTimer = null;
  function onClick(event) {
    var button = event.target && event.target.closest && event.target.closest('#network-probe');
    if (!event.isTrusted || !button || button.disabled) return;
    var input = document.getElementById('url');
    clickEndpoint = input ? input.value.trim() : null;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(function () { clickEndpoint = null; }, 0);
  }
  function onBind(event) {
    var hello;
    try { hello = JSON.parse(event.data); } catch (_) { return; }
    if (!hello || hello.kind !== 'ros-native-diagnostics' || hello.nonce !== nonce
        || !event.ports || event.ports.length !== 1) return;
    if (port) port.close();
    port = event.ports[0];
    window.removeEventListener('message', onBind);
    port.onmessage = function (message) {
      try {
        var detail = JSON.parse(message.data);
        if (detail && typeof detail.requestId === 'string') {
          window.dispatchEvent(new CustomEvent('androidnetworkdiagnostics', {detail: detail}));
        }
      } catch (_) { /* A malformed native reply has no privileges. */ }
    };
    port.start();
    Object.defineProperty(window, 'AndroidDiagnostics', {configurable: true, value: Object.freeze({
      requestNetworkDiagnostics: function (url, requestId) {
        var input = document.getElementById('url');
        if (!port || typeof url !== 'string' || typeof requestId !== 'string'
            || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)
            || clickEndpoint === null || clickEndpoint !== url
            || !input || input.value.trim() !== url) {
          throw new Error('请点击网络诊断按钮，以检查当前填写的地址');
        }
        clickEndpoint = null; // One trusted click authorizes one check of that exact endpoint.
        port.postMessage(JSON.stringify({url: url, requestId: requestId}));
      }
    })});
    window.dispatchEvent(new Event('androiddiagnosticsready'));
  }
  function dispose() {
    clearTimeout(clickTimer);
    clickEndpoint = null;
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('message', onBind);
    if (port) port.close();
    port = null;
    delete window.AndroidDiagnostics;
    delete window.__disposeAndroidDiagnostics;
  }
  Object.defineProperty(window, '__disposeAndroidDiagnostics', {configurable: true, value: dispose});
  document.addEventListener('click', onClick, true);
  window.addEventListener('message', onBind);
})();
