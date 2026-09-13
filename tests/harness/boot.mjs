// Builds the init-script source injected via page.addInitScript() -- runs
// before boot.js/app.js (index.html:8+), so window.__MDV_BOOT and
// window.chrome.webview both exist by the time app.js reads them at
// assets/app.js:7,17.
//
// The bridge stub's postMessage() calls window.__mdvNativeHandle(msg) -- a
// function Playwright's page.exposeFunction() bridges back to the real
// FakeNative instance living in the Node test process (tools/dev/fake-native.mjs).
// That keeps fake-native's state directly inspectable by the test (no
// JSON round-trip through page.evaluate() needed) while still driving the
// page through the exact same window.chrome.webview surface app.js expects.

export function bootInitScript({ testHooks = true, debug = true, solo = true, hasDoc = false, settings = null } = {}) {
  const boot = {
    settings, version: 'test', dark: false, zoom: 100, solo, hasDoc, repeat: 1,
    editorTest: false, rejectionTest: false, testHooks, debug,
  };
  return `
    window.__MDV_BOOT = ${JSON.stringify(boot)};
    (function () {
      class Bridge extends EventTarget {
        postMessage(msg) {
          // Fire-and-forget from the page's perspective, exactly like the
          // real chrome.webview.postMessage -- any reply arrives later as a
          // genuine 'message' event, never as this call's return value.
          // debugLog is special: it's OUTBOUND only (app.js posts it, never
          // receives it back). Forward it straight to Node via an exposed
          // function rather than a page-side event -- a test registers its
          // wait in Node BEFORE triggering anything, so there is no
          // page-round-trip race between "listener armed" and "event fired"
          // the way a page-internal CustomEvent + a separate page.evaluate
          // to read it would have.
          if (msg && msg.type === 'debugLog') window.__mdvOnDebugLog(msg.level, msg.text);
          window.__mdvNativeHandle(msg);
        }
      }
      window.chrome = window.chrome || {};
      window.chrome.webview = new Bridge();
      // Exposed for the harness to deliver outbound messages (from
      // FakeNative's onOutbound hook) as real MessageEvents, matching
      // exactly what app.js's bridge.addEventListener('message', ...) sites
      // (e.g. the waitForMessage helper pattern) expect.
      window.__mdvDeliver = (msg) => {
        window.chrome.webview.dispatchEvent(new MessageEvent('message', { data: msg }));
      };
    })();
  `;
}
