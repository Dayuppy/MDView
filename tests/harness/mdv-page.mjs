// Thin wrapper API around a Playwright Page + FakeNative pair -- the object
// a spec file actually interacts with. Keeps page.evaluate() call shapes in
// one place rather than scattered through every spec.

import { EventEmitter } from 'node:events';

export class MdvPage {
  /** @param {import('playwright').Page} page
   *  @param {import('../../tools/dev/fake-native.mjs').FakeNative} native */
  constructor(page, native) {
    this.page = page;
    this.native = native;
    // debugLog is OUTBOUND-only from the page's perspective (app.js posts
    // it, never receives it back), so waiting for one can't reuse the
    // bridge's incoming-message path. The boot-injected bridge stub calls
    // window.__mdvOnDebugLog(level, text) -- exposed straight to this
    // emitter -- so a wait is registered here in Node BEFORE triggering
    // anything, with no page-round-trip race between "listener armed" and
    // "event fired" the way a page-internal listener + a separate
    // page.evaluate to read it would have.
    //
    // Buffered, not just a live EventEmitter: 'renderComplete' and
    // 'domSummary' post back-to-back in app.js's own synchronous code, but
    // reach Node as two separate async exposeFunction round-trips -- a
    // real race caught by hand: `await openDoc()` (waits for
    // renderComplete) resolving, then the NEXT line calling
    // waitForDebugLog('domSummary'), missed domSummary because it had
    // already arrived and fired with nobody listening yet. Recording every
    // occurrence and having waitForDebugLog check history first, live-wait
    // only as a fallback, makes this un-missable regardless of call order.
    this._debugLog = new EventEmitter();
    this._debugLogHistory = new Map(); // level -> text[]
  }

  /** Wired to page.exposeFunction('__mdvOnDebugLog', ...) by fixtures.mjs. */
  _onDebugLog(level, text) {
    if (!this._debugLogHistory.has(level)) this._debugLogHistory.set(level, []);
    this._debugLogHistory.get(level).push(text);
    this._debugLog.emit(level, text);
  }

  /** Loads a document (Node-side, mirrors a real launch handing OpenDocument
   *  a path) and waits for the page's own renderComplete signal. */
  async openDoc(text, { name = 'test.md', dir = 'C:\\docs', path, plain = false, bom, crlf, encoding, size, modified } = {}) {
    const fullPath = path || `${dir}\\${name}`;
    const waitDone = this.waitForDebugLog('renderComplete');
    this.native.loadDoc({ path: fullPath, dir, name, text, plain, bom, crlf, encoding, size, modified });
    await waitDone;
  }

  /** Awaits the page's debugLog signal for a given level (e.g.
   *  'renderComplete', 'domSummary') -- consumes the OLDEST not-yet-consumed
   *  occurrence already seen for this level, live-waiting only if none is
   *  buffered yet. Call order across different levels doesn't matter. */
  waitForDebugLog(level, timeoutMs = 10000) {
    const buffered = this._debugLogHistory.get(level);
    if (buffered && buffered.length) return Promise.resolve(buffered.shift());

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._debugLog.removeListener(level, onEvt);
        reject(new Error(`timed out waiting for debugLog level=${level}`));
      }, timeoutMs);
      const onEvt = () => {
        clearTimeout(timer);
        // _onDebugLog already pushed it into history; consume from there so
        // this and the buffered-fast-path share one source of truth.
        resolve(this._debugLogHistory.get(level).shift());
      };
      this._debugLog.once(level, onEvt);
    });
  }

  /** Calls a path into window.__MDV_TEST, e.g. 'TOOLBAR_ACTIONS.bold' or
   *  'runSearch' with args. Returns the call's return value (structured-
   *  cloned back across the page.evaluate boundary). */
  async call(dottedPath, ...args) {
    return this.page.evaluate(
      ({ dottedPath, args }) => {
        const parts = dottedPath.split('.');
        let obj = window.__MDV_TEST;
        for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
        const fn = obj[parts[parts.length - 1]];
        return fn.apply(obj, args);
      },
      { dottedPath, args },
    );
  }

  /** Reads window.__MDV_TEST.state (structured-cloned; getters excluded by
   *  clone, so this returns the plain data the `state` getter computes). */
  state() {
    return this.page.evaluate(() => window.__MDV_TEST.state);
  }

  editorValue() {
    return this.page.evaluate(() => window.__MDV_TEST.els.editor.value);
  }

  setEditor(value, selStart, selEnd = selStart) {
    return this.page.evaluate(
      ({ value, selStart, selEnd }) => {
        const editor = window.__MDV_TEST.els.editor;
        editor.value = value;
        editor.setSelectionRange(selStart, selEnd);
      },
      { value, selStart, selEnd },
    );
  }

  /** The most recent outbound message of the given type, or undefined. */
  lastSent(type) {
    const arr = this.native.sent.filter((m) => m.type === type);
    return arr[arr.length - 1];
  }

  /** The most recent INBOUND message (page -> native) of the given type, or
   *  undefined -- for asserting what the page attempted to post even when
   *  FakeNative's simulated handling doesn't otherwise distinguish it (see
   *  fake-native.mjs's `received` comment). */
  lastReceived(type) {
    const arr = this.native.received.filter((m) => m.type === type);
    return arr[arr.length - 1];
  }
}
