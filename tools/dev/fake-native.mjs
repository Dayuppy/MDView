// A faithful port of HandleWebMessage() (src/main.cpp:1243-1566) -- the 18
// inbound message types app.js can post, mirrored closely enough that the
// existing ~130 DOM/JS-level assertions can run against it unchanged. Real
// OS-level side effects (an actual file dialog, actually launching a
// browser, actually revealing Explorer, actually going fullscreen) are
// deliberately NOT performed here -- they're recorded so a test can assert
// intent, matching this whole project's own standing rule that nothing
// disruptive runs unattended. The genuinely native-only assertions (real
// pasted-image file writes under a real docDir, the __abs__ resource-loader
// guards, openPath's UNC rejection) stay covered by the real exe's
// regression suite (tools/regression.ps1) instead of being reproduced here.
//
// Used as `window.__MDV_NATIVE` inside the test/dev page (see
// tests/harness/boot.mjs) -- the bridge stub's postMessage() calls
// `handle(msg)` synchronously and re-dispatches whatever it returns as a
// real `message` event, exactly mirroring the real chrome.webview contract
// app.js already listens on.

function jsonEscape(s) {
  // Loose mirror of JsonEscape (main.cpp) -- good enough for test fixtures,
  // not a general-purpose encoder.
  return String(s);
}

const ALLOWED_PASTE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mdtxt', 'rmd', 'qmd', '']);

function extOf(path) {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  if (dot === -1 || (slash !== -1 && dot < slash)) return '';
  return path.slice(dot + 1).toLowerCase();
}

function isLocalDrivePath(full) {
  return full.length >= 3 && full[0] !== '\\' && full[1] === ':';
}

/**
 * @typedef {object} VirtualDoc
 * @property {string} path
 * @property {string} dir
 * @property {string} name
 * @property {string} text     UTF-8 document body (LF-normalized, as g_docUtf8 holds it)
 * @property {boolean} [plain] non-markdown extension -> literal <pre> rendering
 * @property {boolean} [bom] original file began with a UTF-8 BOM (document-info display only)
 * @property {boolean} [crlf] original file used CRLF line endings (document-info display only)
 * @property {string} [encoding] mirrors TextEncodingLabel() (main.cpp) -- 'UTF-8', 'UTF-8 (BOM)',
 *   'UTF-16 LE', 'UTF-16 BE', or 'ANSI'
 * @property {number} [size] on-disk byte size (document-info display only)
 * @property {number} [modified] last-write time, Unix ms (document-info display only)
 */

export class FakeNative {
  /** @param {{ pastedImageWriter?: (name: string, bytes: Buffer) => void }} [opts] */
  constructor(opts = {}) {
    /** @type {Map<string, VirtualDoc>} keyed by lowercased full path -- the openPath/openDialog VFS */
    this.vfs = new Map();
    this.state = {
      haveDoc: false,
      dirty: false,
      editing: false,
      docPath: '', docDir: '', docName: '', docText: '', docPlain: false,
      docBom: false, docCrlf: false, docEncoding: 'UTF-8', docSize: 0, docModified: 0,
      docToken: 0,   // mirrors g_docToken -- see main.cpp's comment on it
      dark: false,
      windowTitle: 'MD Viewer',
      lastSettingsBlob: null,
      pastedImageCounter: 0,
      titleUpdateCount: 0,   // mirrors UpdateTitle() call count -- makes the
                              // `if (was != g_dirty) UpdateTitle();` guard's
                              // actual purpose (skip redundant work) observable,
                              // since the resulting title STRING is identical
                              // either way.
    };
    /** @type {Array<object>} every outbound message, in order -- for assertions */
    this.sent = [];
    /** @type {Array<object>} every INBOUND message handle() was called with,
     *  in order -- for assertions that need to see what the page attempted
     *  to post even when two message types produce identical simulated
     *  native-side effects here (e.g. saveDoc/saveAsDoc both just echo
     *  'saved' below) and so aren't otherwise distinguishable via `sent`. */
    this.received = [];
    this._nextOpenDialogPath = null;
    this._pastedImageWriter = opts.pastedImageWriter || null;
    /** @type {((msg: object) => void)|null} fires once per outbound message,
     *  regardless of whether it originated from a page-sent `handle()` call
     *  or a Node-side test-setup call like loadDoc() -- the single delivery
     *  point a Playwright fixture hooks to push messages into the real page
     *  as `message` events. */
    this.onOutbound = opts.onOutbound || null;
  }

  // ---- test-setup helpers (no HandleWebMessage equivalent -- these arrange
  // preconditions a real test would set up via the filesystem/dialog) ----

  /** Registers a document the VFS can serve via openPath/openDialog. `size`
   *  defaults to the UTF-8 body's own byte length (plus 3 for a BOM) when
   *  not given explicitly -- close enough for tests that don't care about
   *  the exact on-disk figure; pass it explicitly to assert a specific one. */
  addDoc({ path, dir, name, text, plain = false, bom = false, crlf = false, encoding = 'UTF-8', size, modified = 0 }) {
    const byteSize = size != null ? size : Buffer.byteLength(text, 'utf8') + (bom ? 3 : 0);
    this.vfs.set(path.toLowerCase(), { path, dir, name, text, plain, bom, crlf, encoding, size: byteSize, modified });
  }

  /** The next `openDialog` message resolves to this path (mirrors ShowOpenDialog's result). */
  queueOpenDialog(path) {
    this._nextOpenDialogPath = path;
  }

  /** Directly loads a document as if OpenDocument() just succeeded -- the
   *  common test entry point, mirroring what a real `--mdv-*` launch does
   *  before the page ever sends a message. */
  loadDoc({ path, dir, name, text, plain = false, bom, crlf, encoding, size, modified }, nav = 'new') {
    this.addDoc({ path, dir, name, text, plain, bom, crlf, encoding, size, modified });
    this._openInternal(path, nav);
  }

  /** Simulates a native-initiated `insertImage` message reaching the page --
   *  WM_DROPFILES for a plain drop (`created` false, the default) or the
   *  tail end of a paste/drop that just wrote a brand-new file (`created`
   *  true). There's no HandleWebMessage case to mirror here -- insertImage
   *  is never a reply to something the page sent -- so, like loadDoc(),
   *  this is a test-setup helper for arranging a native-initiated
   *  precondition, not a `handle()` case. Goes through `_post()` so it's
   *  recorded in `sent` and delivered via `onOutbound` exactly like every
   *  other outbound message. */
  insertImage(path, created = false) {
    return this._post({ type: 'insertImage', path, created });
  }

  _updateTitle() {
    let t = this.state.haveDoc ? `${this.state.docName} — MD Viewer` : 'MD Viewer';
    if (this.state.dirty) t = '• ' + t;
    this.state.windowTitle = t;
    this.state.titleUpdateCount++;
  }

  // The SOLE place a message is recorded into `sent` / handed to
  // `onOutbound` -- every outbound message, from any code path, must be
  // constructed via this method exactly once (never pushed into `sent`
  // directly elsewhere), or it will be delivered twice.
  _post(msg) {
    this.sent.push(msg);
    if (this.onOutbound) this.onOutbound(msg);
    return msg;
  }

  _sendToast(text) {
    return this._post({ type: 'toast', text: jsonEscape(text) });
  }

  _sendDocMsg(nav) {
    const s = this.state;
    return this._post({
      type: 'doc', name: s.docName, path: s.docPath, dir: s.docDir,
      plain: s.docPlain ? '1' : '0', nav, tok: String(s.docToken),
      bom: s.docBom ? '1' : '0', crlf: s.docCrlf ? '1' : '0',
      encoding: s.docEncoding, size: String(s.docSize), modified: String(s.docModified),
    });
  }

  _openInternal(path, nav) {
    const doc = this.vfs.get(path.toLowerCase());
    if (!doc) return null;
    const s = this.state;
    s.haveDoc = true;
    s.docPath = doc.path; s.docDir = doc.dir; s.docName = doc.name;
    s.docText = doc.text; s.docPlain = !!doc.plain;
    s.docBom = !!doc.bom; s.docCrlf = !!doc.crlf; s.docEncoding = doc.encoding;
    s.docSize = doc.size; s.docModified = doc.modified;
    s.docToken++;
    s.dirty = false; s.editing = false;
    this._updateTitle();
    return this._sendDocMsg(nav);
  }

  /**
   * Mirrors HandleWebMessage(). Returns an array of outbound messages
   * (possibly empty) produced by this one inbound message -- the caller
   * (the bridge stub) re-dispatches each as a real `message` event.
   * @param {object} msg  Already-parsed (this fake skips the JSON string
   *   round-trip HandleWebMessage does against the real wire format).
   */
  handle(msg) {
    this.received.push(msg);
    const out = [];
    // Accumulates into the RETURN value only. Every message reaching this
    // must already have been through _post() exactly once (either directly,
    // e.g. push(this._post({...})), or indirectly via a helper like
    // _sendToast()/_sendDocMsg()/_openInternal() that already calls _post())
    // -- push() itself never re-records into this.sent, or a message
    // constructed via a helper would be recorded twice.
    const push = (m) => { if (m) out.push(m); return m; };
    const s = this.state;
    if (!msg || typeof msg.type !== 'string') return out;

    switch (msg.type) {
      case 'ready':
        break; // page-lifecycle only in production; nothing to mirror here

      case 'saveSettings':
        if (typeof msg.data === 'string') s.lastSettingsBlob = msg.data;
        break;

      case 'chrome':
        s.dark = msg.dark === '1';
        break;

      case 'title':
        if (typeof msg.text === 'string') s.windowTitle = `${msg.text} — MD Viewer`;
        break;

      case 'openExternal':
        // Recorded only -- NEVER launches anything, matching this whole
        // project's standing rule against disruptive unattended actions.
        push(this._post({ type: '__openExternalRecorded', url: msg.url }));
        break;

      case 'openPath': {
        const path = msg.path;
        const nav = msg.nav || 'link';
        if (typeof path !== 'string' || !isLocalDrivePath(path)) {
          push(this._sendToast('Links to network locations are blocked for your security.'));
          break;
        }
        const doc = this.vfs.get(path.toLowerCase());
        if (!doc) {
          push(this._post({ type: 'openFailed', path }));
          push(this._sendToast('File not found: ' + path));
          break;
        }
        const ext = extOf(path);
        if (MARKDOWN_EXTS.has(ext) || ext === 'txt' || ext === 'text' || ext === 'log') {
          push(this._openInternal(path, nav));
        } else {
          push(this._post({ type: '__openedNonMarkdown', path }));
        }
        break;
      }

      case 'saveDoc':
      case 'saveAsDoc': {
        if (typeof msg.text !== 'string' || !s.haveDoc) break;
        s.docText = msg.text;
        s.docToken++;
        s.dirty = false;
        this._updateTitle();
        push(this._post({ type: 'saved', path: s.docPath }));
        break;
      }

      case 'saveClipboardImage': {
        const ext = msg.ext;
        if (!s.haveDoc || !s.docDir || !ALLOWED_PASTE_EXTS.has(ext)) {
          push(this._sendToast('Could not save the pasted image.'));
          break;
        }
        let bytes;
        try { bytes = Buffer.from(msg.data, 'base64'); } catch { bytes = Buffer.alloc(0); }
        if (!bytes.length) {
          push(this._sendToast('Could not save the pasted image.'));
          break;
        }
        s.pastedImageCounter++;
        const name = `pasted-image-${s.pastedImageCounter}.${ext}`;
        if (this._pastedImageWriter) this._pastedImageWriter(name, bytes);
        push(this._post({ type: 'insertImage', path: name, created: true }));
        break;
      }

      case 'newDoc':
        s.haveDoc = true; s.dirty = false; s.editing = false;
        s.docPath = ''; s.docDir = ''; s.docName = 'Untitled';
        s.docText = ''; s.docPlain = false;
        s.docBom = false; s.docCrlf = false; s.docEncoding = 'UTF-8';
        s.docSize = 0; s.docModified = 0;
        s.docToken++;
        this._updateTitle();
        push(this._sendDocMsg('new'));
        break;

      case 'editing':
        s.editing = msg.on === '1';
        break;

      case 'dirty': {
        const was = s.dirty;
        s.dirty = msg.on === '1';
        if (was !== s.dirty) this._updateTitle();
        break;
      }

      case 'openDialog': {
        if (this._nextOpenDialogPath) {
          const path = this._nextOpenDialogPath;
          this._nextOpenDialogPath = null;
          push(this._openInternal(path, 'new'));
        }
        break;
      }

      case 'revealDoc':
        if (s.haveDoc) push(this._post({ type: '__revealedInExplorer', path: s.docPath }));
        break;

      // Real ExportHtml() (main.cpp) shows a save dialog then writes to
      // disk -- not meaningfully fakeable without a real dialog, and not
      // needed here: a spec asserting the HTML itself only needs
      // `mdv.lastSent('exportHtml').html`, which requires no bridge
      // support at all. Recorded anyway so a test CAN assert intent
      // (the same convention openExternal/revealDoc already use for a
      // real OS-level side effect this harness deliberately never performs).
      case 'exportHtml':
        if (s.haveDoc && typeof msg.html === 'string') push(this._post({ type: '__exportedHtml', html: msg.html }));
        break;

      case 'zoom':
      case 'fullscreen':
      case 'reload':
      case 'debugLog':
        // No page-observable outbound effect in production for these (zoom
        // drives a native title-bar/DPI change; fullscreen toggles the real
        // window; reload re-issues the current doc -- not meaningfully
        // fakeable without a real window, and not needed by anything this
        // harness migrates).
        break;

      default:
        break;
    }
    return out.filter(Boolean);
  }
}
