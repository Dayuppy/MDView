// MD Viewer — application logic. Everything runs locally inside the WebView;
// the native shell is reached only through chrome.webview.postMessage.
(function () {
'use strict';

/* ================================================================ bridge */

const bridge = window.chrome && window.chrome.webview;
function post(msg) { if (bridge) bridge.postMessage(msg); }

const $ = (id) => document.getElementById(id);
const content = $('content');
const main = $('main');
const welcome = $('welcome');
const announce = $('announce');

const BOOT = window.__MDV_BOOT || { settings: null, version: 'dev', dark: false, zoom: 100, solo: true, hasDoc: false, repeat: 1, editorTest: false, rejectionTest: false, selfTokenTest: false, testHooks: false };
if (!BOOT.repeat) BOOT.repeat = 1;
// Reports how long the vendor <script> block (index.html, 21 tags, 709KB)
// took to load+parse+execute in a debug build. Resource Timing, not an
// inline probe (tried first, silently no-op'd -- CSP's script-src
// https://app.local has no 'unsafe-inline'): the last vendor script's
// responseEnd approximates when the whole parser-blocking block finished
// (each blocking <script> only starts fetching once the previous one has
// finished executing). This is what investigated the "lazy renderer"
// backlog item (docs/BACKLOG.md) -- kept as a permanent phase mark since
// the finding was genuinely surprising: splitting the ~709KB into an eager
// ~240KB core (markdown-it + plugins + DOMPurify) plus on-demand KaTeX/
// mhchem/texmath + highlight.js/language-packs, gated on a cheap regex hint
// per document, did NOT measurably reduce this number (~2.1s either way,
// cold or warm profile) -- the cost isn't proportional to script payload at
// all. index.html's own HTML resource finishes loading in ~5-12ms and
// app.js's own first line runs within ~10ms of the last vendor script, so
// the ~2.1s is genuinely concentrated in this block's execution window, but
// removing 66% of its bytes didn't touch it -- most likely a fixed
// per-process V8/renderer warmup cost front-loaded onto whichever script
// happens to run first, not something page-level script splitting can fix.
// That change was reverted rather than kept for a benefit it doesn't
// deliver; this phase mark stays as the evidence, for whoever investigates
// the underlying fixed cost next.
if (BOOT.debug && bridge) {
  const nginx = performance.getEntriesByName('https://app.local/vendor/lang-nginx.min.js')[0];
  if (nginx) post({ type: 'debugLog', level: 'vendorScriptsMs', text: String(Math.round(nginx.responseEnd)) });
}

/* ================================================================ debug/headless forwarding

   Only active when the native shell launched with --mdv-headless (a debug
   build — see build.ps1 -Debug). Forwards console output and uncaught JS
   errors to the native log, and reports once a render fully settles, which
   the native side uses to trigger a screenshot and self-close for scripted
   testing. None of this runs, or costs anything, in a normal launch. */
if (BOOT.debug && bridge) {
  const send = (level, args) => {
    try { post({ type: 'debugLog', level, text: Array.from(args).map(String).join(' ') }); } catch (e) {}
  };
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { send(level, args); orig(...args); };
  }
  window.addEventListener('error', (e) => send('error', [e.message, e.filename + ':' + e.lineno, e.error && e.error.stack]));
  window.addEventListener('unhandledrejection', (e) => send('error', ['unhandledrejection:', e.reason]));
}
// renderMermaids() is deliberately called without awaiting it (see its own
// comment) so a document full of diagrams doesn't block normal rendering —
// but that means the "render complete" signal below could otherwise fire,
// and a headless screenshot fire with it, before any diagram has actually
// drawn. Defer the signal when diagrams are still pending; renderMermaids()
// sends it itself, via debugMermaidsSettled(), once they're done.
let debugPendingRenderMs = null;

function debugRenderComplete(ms) {
  if (!BOOT.debug) return;
  if (content.querySelector('.mermaid-fig.pending')) { debugPendingRenderMs = ms; return; }
  sendDebugRenderComplete(ms);
}
function debugMermaidsSettled() {
  if (debugPendingRenderMs == null) return;
  const ms = debugPendingRenderMs;
  debugPendingRenderMs = null;
  sendDebugRenderComplete(ms);
}
function sendDebugRenderComplete(ms) {
  const mem = performance.memory
    ? ` jsHeapMB=${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)}` : '';
  post({ type: 'debugLog', level: 'renderComplete',
    text: `ms=${Math.round(ms)} path=${lastRenderPath} chunks=${lastChunkCount}`
        + ` domNodes=${content.children.length}${mem}${debugTimingSummary()}` });
  post({ type: 'debugLog', level: 'domSummary', text: debugDomSummary() });
  // A diagram-error <figure> must not still carry role="img" -- per the
  // ARIA spec that makes all of its descendants presentational, which would
  // silently hide the fallback note/source from screen readers. Only costs
  // anything when a diagram actually failed to render.
  const diagErr = content.querySelector('.diagram-error');
  if (diagErr) {
    post({ type: 'debugLog', level: 'diagramErrorProbe',
      text: 'role=' + JSON.stringify(diagErr.getAttribute('role')) +
        ' ariaLabel=' + JSON.stringify(diagErr.getAttribute('aria-label')) +
        ' hasNote=' + !!diagErr.querySelector('.diagram-error-note') +
        ' hasSource=' + !!diagErr.querySelector('pre > code') });
  }
}

// A structural fingerprint of the rendered document. Screenshots only show the
// first screenful and can't be diffed reliably; these counts cover the whole
// document and turn "did that refactor quietly stop wrapping tables" into a
// visible number. Every entry is something decorate() is responsible for
// producing, so a regression in the decoration pipeline shows up as a zero.
function debugDomSummary() {
  const n = (sel) => content.querySelectorAll(sel).length;
  return [
    `headings=${n('h1,h2,h3,h4,h5,h6')}`,
    `anchors=${n('a.hanchor')}`,
    `tableWraps=${n('.table-wrap')}`,
    `tables=${n('table')}`,
    `orderedLists=${n('ol')}`,
    `codeBlocks=${n('pre > code')}`,
    `copyBtns=${n('.copybtn')}`,
    `katex=${n('.katex')}`,
    `mermaid=${n('.mermaid-fig')}`,
    `alerts=${n('.md-alert')}`,
    `taskBoxes=${n('input[type="checkbox"]')}`,
    `footnotes=${n('.footnotes li')}`,
    `images=${n('img')}`,
    `links=${n('a[href]')}`,
    `ariaBusy=${content.getAttribute('aria-busy')}`
  ].join(' ');
}

/* ---------------- render-phase timing ----------------
   Wall-clock totals answer "is it slow"; these answer "slow where", which is
   the only question that leads to a fix. Each stage of a render stamps its
   own duration here and the next renderComplete carries them all. Costs
   nothing outside a headless debug run — the marks are no-ops otherwise. */

const debugTimings = {};
function debugTime(name, ms) { if (BOOT.debug) debugTimings[name] = (debugTimings[name] || 0) + ms; }
function debugTimingReset() { for (const k of Object.keys(debugTimings)) delete debugTimings[k]; }
function debugTimingSummary() {
  const keys = Object.keys(debugTimings);
  if (!keys.length) return '';
  return ' | ' + keys.map((k) => `${k}=${debugTimings[k].toFixed(1)}`).join(' ');
}

/* ---------------- repeat benchmark (--mdv-repeat=N) ----------------
   A single sample of anything on a busy desktop is close to meaningless —
   run-to-run spread here routinely exceeds the size of the change being
   measured. Re-rendering the same source N times in the same process and
   reporting min/median/max makes a real difference distinguishable from
   scheduler noise, and exercises the reused worker the way a real session
   does rather than only ever measuring a cold first render. */

async function debugRunBenchmark(text, dir, n) {
  const times = [];
  for (let i = 0; i < n; i++) {
    // renderMarkdownInto() resets debugTimings itself now (every render does,
    // not just this loop), so there's nothing left to do here but time it.
    const t0 = performance.now();
    docGeneration++;              // a fresh generation so nothing mid-flight bails this render
    content.innerHTML = '';
    await renderMarkdownInto(text, dir);
    times.push(performance.now() - t0);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  // The preceding renderComplete already reports jsHeapMB for the cold first
  // render (see sendDebugRenderComplete); this is the only place that reports
  // it again after N more renders in the same process, so a leak that grows
  // per-render — as opposed to a one-time cold-start allocation — actually
  // shows up as a delta between the two lines instead of being invisible.
  const mem = performance.memory
    ? ` jsHeapMB=${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)}` : '';
  post({ type: 'debugLog', level: 'benchComplete',
    text: `n=${n} min=${sorted[0].toFixed(1)} median=${median.toFixed(1)}`
        + ` mean=${mean.toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)}`
        + ` path=${lastRenderPath} chunks=${lastChunkCount}${mem}`
        + ` all=[${times.map((t) => t.toFixed(1)).join(',')}]${debugTimingSummary()}` });
}

/* ---------------- native-only self-test (--mdv-editor-test) ----------------
   What's left here, after tests/MIGRATION.md's assertion migration moved
   everything else out to tests/specs/*.spec.mjs and tests/node/*.test.mjs,
   is exactly the checks that need the real native exe: openExternal's and
   the __abs__/openPath resource-loader guard's defense-in-depth (main.cpp's
   own independent scheme/UNC checks, reachable only via a real
   postMessage->native->postMessage round trip), and saveClipboardImage's
   real-file-write round trip (FakeNative's simulation never writes an
   actual file unless a pastedImageWriter callback is supplied, which the
   shared Playwright fixture doesn't). Runs after the first render (see the
   BOOT.editorTest check in renderDocument), since it needs a loaded
   document before enterEdit() will do anything. */
async function debugRunNativeTest() {
  const results = [];

  if (!editing) {
    // openExternal defense-in-depth: the real link-click handler already
    // filters hrefs to http(s)/mailto in JS before ever posting this
    // message, so native's OWN independent scheme check (main.cpp) can only
    // be exercised by a message that bypasses that filter -- exactly the
    // scenario where a compromised/buggy renderer, not a real user click,
    // is what reaches native. A REAL (non-stubbed) postMessage, so this
    // genuinely round-trips to native and back into its log, not simulated.
    // Deliberately tests ONLY the rejection path: the allowed branch
    // genuinely launches the user's default browser, a real, visible,
    // disruptive side effect no automated test should ever trigger.
    // Verified natively (regression.ps1 greps the log for the rejection
    // line), not here -- there's nothing for this function itself to assert.
    post({ type: 'openExternal', url: 'javascript:alert(1)' });

    // IsSafeLocalPath()'s __abs__/ resource-loader guard (main.cpp): confines
    // a document-referenced local image/media path to the document's own
    // folder subtree, and rejects UNC (\\server\share) paths outright --
    // merely canonicalizing a UNC target is safe (GetFullPathNameW is pure
    // string manipulation, no I/O), but actually STATing or READING one
    // triggers an outbound SMB/NTLM handshake, which could leak the user's
    // credential hash to an attacker-authored path the instant a malicious
    // document is opened. windowsPathFrom()/toDocUrl() already filter this
    // client-side before ever constructing an __abs__/ URL (see the
    // 'Protocol-relative ... and UNC ... inputs' comment above), so -- same
    // shape as the openExternal check above -- this can only be exercised
    // for real by a raw fetch() that bypasses that filter, which is exactly
    // the scenario a compromised/buggy renderer (not a real markdown image)
    // would produce. A syntactically-unresolvable hostname is used for the
    // UNC probe specifically so that even if this guard were broken, no real
    // network resolution or SMB handshake would ever occur -- the failure
    // mode of a broken guard here must stay contained to "wrong HTTP status
    // in this test", never "real credential material sent to a host".
    // The traversal target has a real media extension and genuinely exists
    // (see tools/regression.ps1's editortest scenario setup) specifically
    // so this exercises IsSafeLocalPath()'s g_docDir confinement itself,
    // not incidentally get shielded by MimeForExt()'s separate media-only
    // whitelist the way a non-media system file (e.g. win.ini) would be.
    // BOOT.travDir (main.cpp's --mdv-trav-dir=, forwarded from
    // regression.ps1's own $travTargetDir) is the single place this
    // directory name is ever spelled out -- it used to be a second,
    // independently hardcoded literal here, which a rename in just one
    // place would have left this check passing for the wrong reason (404
    // because the file doesn't exist at the mismatched path, not because
    // the confinement guard actually rejected it).
    const travUrl = 'https://doc.local/__abs__/' +
      encodeURIComponent(doc.dir + '\\..\\' + BOOT.travDir + '\\mdv-traversal-target.png');
    const uncUrl = 'https://doc.local/__abs__/' +
      encodeURIComponent('\\\\mdv-nonexistent-security-probe-testhost\\share\\x');
    const goodUrl = 'https://doc.local/__abs__/' + encodeURIComponent(doc.dir + '\\editortest-probe.png');
    const [travResp, uncResp, goodResp] = await Promise.all([fetch(travUrl), fetch(uncUrl), fetch(goodUrl)]);
    const passTraversal = travResp.status === 404;
    results.push((passTraversal ? 'PASS' : 'FAIL') +
      ' __abs__/ resource loader: a path-traversal attempt escaping the document\'s own folder is rejected (404), not served' +
      (passTraversal ? '' : ' status=' + travResp.status));
    const passUnc = uncResp.status === 404;
    results.push((passUnc ? 'PASS' : 'FAIL') +
      ' __abs__/ resource loader: a UNC (\\\\server\\share) path is rejected outright, guarding against an SMB/NTLM credential-hash leak' +
      (passUnc ? '' : ' status=' + uncResp.status));
    const passGood = goodResp.status === 200;
    results.push((passGood ? 'PASS' : 'FAIL') +
      ' __abs__/ resource loader: a genuine in-bounds path still loads correctly (the guard isn\'t over-blocking)' +
      (passGood ? '' : ' status=' + goodResp.status));

    // The other native call site of this same UNC guard: openPath (a click
    // on a local-file link the document's own content pointed at, via
    // decorate()'s data-open attribute) -- deliberately scoped there rather
    // than into OpenDocument() itself, since OpenDocument() is also reached
    // from a path the USER explicitly chose (File > Open, drag-and-drop),
    // where a network location is legitimate. Bypasses the same client-side
    // filter link-clicks normally go through, to exercise native's own
    // independent check; the real, visible toast is the observable result.
    const savedToastText = toastEl.textContent;
    const savedToastHidden = toastEl.hidden;
    toastEl.hidden = true;
    post({ type: 'openPath', path: '\\\\mdv-nonexistent-security-probe-testhost\\share\\x', nav: 'link' });
    // A real postMessage->native->postMessage round trip, not a synthetic
    // same-thread dispatch (contrast the zoom-toast-dedup test above, which
    // deliberately dispatches a synthetic MessageEvent to test only the JS
    // reaction in isolation) -- so the toast's arrival must actually be
    // awaited rather than checked immediately after posting.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const passOpenPathUnc = !toastEl.hidden && /network locations are blocked/.test(toastEl.textContent);
    results.push((passOpenPathUnc ? 'PASS' : 'FAIL') +
      ' openPath: a UNC path reaching native directly (bypassing the link-click filter) is still rejected with the real toast' +
      (passOpenPathUnc ? '' : ' toastText=' + JSON.stringify(toastEl.textContent) + ' hidden=' + toastEl.hidden));
    toastEl.textContent = savedToastText;
    toastEl.hidden = savedToastHidden;

  }

  if (!editing) enterEdit();
  // The 31-case toolbar-action table (every TOOLBAR_ACTIONS entry, clicked
  // via its real button's data-fmt attribute, plus 3 fresh-eyes-review
  // regression cases) migrated to tests/specs/toolbar.spec.mjs -- see
  // tests/MIGRATION.md. Deleted here rather than kept as a duplicate.

  // Pasting an actual screenshot (saveClipboardImage -> native writes a new
  // file -> insertImage) — real round trip through the actual native
  // process, not simulated: post() reaches the real C++ handler, which
  // really decodes base64 and really writes a file next to the open
  // document. Awaits the genuine async response instead of assuming timing.
  function waitForMessage(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { bridge.removeEventListener('message', onMsg); resolve(null); }, timeoutMs);
      function onMsg(e) {
        if (predicate(e.data)) { clearTimeout(timer); bridge.removeEventListener('message', onMsg); resolve(e.data); }
      }
      bridge.addEventListener('message', onMsg);
    });
  }
  const testPayload = 'dGVzdC1pbWFnZS1ieXRlcy0xMjM0NQ==';   // base64 of 'test-image-bytes-12345'
  editor.value = '';
  editor.setSelectionRange(0, 0);
  const wait1 = waitForMessage((m) => m && m.type === 'insertImage', 10000);
  post({ type: 'saveClipboardImage', data: testPayload, ext: 'png' });
  const msg1 = await wait1;
  const pass1 = !!msg1 && /pasted-image-\d+\.png$/.test(msg1.path) && editor.value.includes(msg1.path);
  results.push((pass1 ? 'PASS' : 'FAIL') + ' saveClipboardImage: writes a real file and inserts its path' +
    (pass1 ? '' : ' got=' + JSON.stringify(msg1) + ' editorValue=' + JSON.stringify(editor.value)));

  // A pasted image writes a file the reader never explicitly saved — that
  // needs to be visible, not just announced to a screen reader, or a
  // sighted user has no way to notice a new file appeared in their folder.
  const passToast = !toastEl.hidden && !!msg1 && toastEl.textContent.includes(msg1.path);
  results.push((passToast ? 'PASS' : 'FAIL') + ' saveClipboardImage: shows a visible toast naming the new file' +
    (passToast ? '' : ' toastHidden=' + toastEl.hidden + ' toastText=' + JSON.stringify(toastEl.textContent)));

  // Posting the same payload again should NOT reuse the first filename —
  // which only happens if that first file was genuinely written to disk
  // (the collision check is GetFileAttributesW against the real path), so
  // this is also indirect proof the first save actually succeeded.
  const wait2 = waitForMessage((m) => m && m.type === 'insertImage', 10000);
  post({ type: 'saveClipboardImage', data: testPayload, ext: 'png' });
  const msg2 = await wait2;
  const pass2 = !!msg1 && !!msg2 && msg2.path !== msg1.path && /pasted-image-\d+\.png$/.test(msg2.path);
  results.push((pass2 ? 'PASS' : 'FAIL') + ' saveClipboardImage: a second paste gets a different filename (proves the first write happened)' +
    (pass2 ? '' : ' got=' + JSON.stringify(msg2)));

  const failures = results.filter((r) => r.startsWith('FAIL')).length;
  post({ type: 'debugLog', level: 'editorTestComplete',
    text: `n=${results.length} failures=${failures} | ${results.join(' | ')}` });
}

/* ================================================================ settings */

const DEFAULTS = {
  theme: 'system', font: 'system', fontSize: 100, lineHeight: 1.6,
  letterSpacing: 0, contentWidth: 'normal', motion: 'auto',
  highContrast: false, underlineLinks: true, dimImages: true,
  codeWrap: false, spellcheck: false, sidebar: true, sidebarWidth: 288,
  findCase: false, findWord: false, findRegex: false, restoreLastDoc: false,
  recent: [], positions: {}
};

let S = Object.assign({}, DEFAULTS, window.__MDV_SETTINGS || {});
if (!Array.isArray(S.recent)) S.recent = [];
if (typeof S.positions !== 'object' || !S.positions) S.positions = {};
// First run only: if the OS asks for higher contrast, start there. After that
// the reader's own choice in the Aa panel always wins.
if (!window.__MDV_SETTINGS && window.matchMedia('(prefers-contrast: more)').matches) {
  S.highContrast = true;
}

let saveTimer = null;
function save(immediate) {
  clearTimeout(saveTimer);
  const doSave = () => post({ type: 'saveSettings', data: JSON.stringify(S) });
  if (immediate) doSave();
  else saveTimer = setTimeout(doSave, 350);
}

let isDark = false;
function applyPrefs() {
  isDark = window.__mdvApplyPrefs(S);
  post({ type: 'chrome', dark: isDark ? '1' : '0' });
  updateThemeButton();
  // spellcheck is a real DOM property, not something boot.js's CSS-variable
  // approach (runs in <head>, before #editor even exists) can set -- applied
  // here instead, on both initial load and every live toggle.
  editor.spellcheck = !!S.spellcheck;
  if (mermaidTheme && mermaidTheme !== (isDark ? 'dark' : 'default')) {
    // renderMermaids() only ever picks up *pending* diagrams — the normal
    // case, as new ones stream in. To re-theme diagrams that already
    // rendered, put them back in that state (clearing their old-theme SVG)
    // so the same incremental path redraws them.
    const already = content.querySelectorAll('.mermaid-fig:not(.pending)');
    if (already.length) {
      already.forEach((f) => { f.classList.add('pending'); f.classList.remove('diagram-error'); f.textContent = ''; });
      renderMermaids();
    }
  }
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (S.theme === 'system') applyPrefs();
});
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
  if (S.motion === 'auto') applyPrefs();
});

/* ================================================================ toast + announce */

const toastEl = $('toast');
let toastTimer = null;
function toast(text, ms) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms || 2200);
  say(text);
}
function say(text) {
  announce.textContent = '';
  requestAnimationFrame(() => { announce.textContent = text; });
}

/* ================================================================ markdown engine

   The renderer's configuration lives in md-setup.js, shared byte-for-byte
   with worker.js (the off-main-thread renderer used for large documents —
   see renderContentMarkdown() below), so the two can never drift apart. */

const md = self.mdvCreateRenderer();

const PURIFY_CFG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ADD_TAGS: ['semantics', 'annotation'],
  ADD_ATTR: ['align', 'width', 'height', 'open', 'disabled', 'checked', 'type', 'start',
    'controls', 'poster', 'loading', 'encoding', 'definitionurl', 'aria-hidden', 'aria-label'],
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'dialog', 'iframe'],
  // DOMPurify's default ALLOWED_URI_REGEXP requires any "word:" prefix on a
  // src/href value to be one of a handful of allowlisted schemes (http,
  // mailto, ...); anything else reads as an untrusted scheme (like
  // "javascript:") and DOMPurify drops the attribute entirely. That default
  // has no concept of a Windows drive letter, so an absolute path such as
  // "C:/docs/image.png" — produced by the drag-drop-image-outside-doc-folder
  // fallback in main.cpp's WM_DROPFILES handler — silently loses its src
  // with no error shown to the user. This is DOMPurify's own default regex
  // (see vendor/purify.min.js) plus one added alternative that allows a
  // single ASCII letter followed by ":" and a path separator; it does not
  // relax the scheme allowlist for anything else, so "javascript:", "data:"
  // (outside the svg profile), "vbscript:", etc. are still rejected exactly
  // as before.
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[a-zA-Z]:[\\/]|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
};

// Same rules, but handing back the DocumentFragment DOMPurify already built
// rather than a string. Sanitizing to a string and assigning it to innerHTML
// parses the same markup twice — once inside DOMPurify to inspect it, and
// again on the way back in — and for a large document that second parse is
// pure waste. Identical security properties: it is the very same cleaned
// tree, just never serialized in between.
const PURIFY_CFG_FRAGMENT = Object.assign({}, PURIFY_CFG, { RETURN_DOM_FRAGMENT: true });

/* ---------------- front matter ---------------- */

// Defined once, shared with worker.js \u2014 see md-setup.js.
const splitFrontMatter = self.mdvSplitFrontMatter;

function buildFrontMatter(fm) {
  const details = document.createElement('details');
  details.className = 'frontmatter';
  const summary = document.createElement('summary');
  summary.textContent = 'Document metadata';
  details.appendChild(summary);
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  let lastTd = null;
  const addRow = (key, val, raw) => {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    const td2 = document.createElement('td');
    if (raw) { td2.colSpan = 2; td2.className = 'fm-raw'; td2.textContent = val; tr.append(td2); }
    else { td1.textContent = key; td2.textContent = val; tr.append(td1, td2); }
    tbody.appendChild(tr);
    return td2;
  };
  for (const raw of fm.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const li = line.match(/^\s+-\s+(.*)$/);
    if (li && lastTd) {
      lastTd.textContent += (lastTd.textContent ? ', ' : '') + li[1];
      continue;
    }
    const kv = line.match(/^([\w][\w .-]*)\s*:\s*(.*)$/);
    if (kv) {
      lastTd = addRow(kv[1], kv[2].replace(/^["']|["']$/g, ''), false);
    } else {
      // Nested maps, block scalars, comments — shown verbatim so nothing is lost.
      addRow('', line, true);
      lastTd = null;
    }
  }
  table.appendChild(tbody);
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.appendChild(table);
  details.appendChild(wrap);
  return details;
}

/* ---------------- DOM decoration after sanitize ---------------- */

const ALERT_TYPES = {
  NOTE: { cls: 'note', label: 'Note', icon: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 3a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm1 8H7V7h2Z' },
  TIP: { cls: 'tip', label: 'Tip', icon: 'M8 1a4.5 4.5 0 0 0-2.5 8.2V11a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V9.2A4.5 4.5 0 0 0 8 1ZM6.5 14a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5Z' },
  IMPORTANT: { cls: 'important', label: 'Important', icon: 'M13 2H3a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 3 12h2v2.5L8.5 12H13a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 13 2ZM8 4a.9.9 0 0 1 .9.9V7.6a.9.9 0 0 1-1.8 0V4.9A.9.9 0 0 1 8 4Zm0 6.4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z' },
  WARNING: { cls: 'warning', label: 'Warning', icon: 'M8.9 2.1a1 1 0 0 0-1.8 0l-6 11A1 1 0 0 0 2 14.5h12a1 1 0 0 0 .9-1.4ZM8 5.5a.9.9 0 0 1 .9.9v2.7a.9.9 0 0 1-1.8 0V6.4a.9.9 0 0 1 .9-.9Zm0 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z' },
  CAUTION: { cls: 'caution', label: 'Caution', icon: 'M10.7 1.5H5.3L1.5 5.3v5.4l3.8 3.8h5.4l3.8-3.8V5.3ZM8 4.5a.9.9 0 0 1 .9.9v2.7a.9.9 0 0 1-1.8 0V5.4a.9.9 0 0 1 .9-.9Zm0 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z' }
};

function transformAlerts(root) {
  for (const bq of root.querySelectorAll('blockquote')) {
    const p = bq.querySelector(':scope > p');
    if (!p) continue;
    const m = (p.textContent || '').match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/);
    if (!m) continue;
    const info = ALERT_TYPES[m[1]];
    // remove the marker text from the first text node(s)
    let toRemove = m[0].length;
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node;
    while (toRemove > 0 && (node = walker.nextNode())) {
      const take = Math.min(node.data.length, toRemove);
      node.data = node.data.slice(take);
      toRemove -= take;
    }
    if (p.firstChild && p.firstChild.nodeName === 'BR') p.firstChild.remove();
    if (!p.textContent.trim() && !p.children.length) p.remove();

    const div = document.createElement('div');
    div.className = 'md-alert ' + info.cls;
    div.setAttribute('role', m[1] === 'WARNING' || m[1] === 'CAUTION' ? 'alert' : 'note');
    const title = document.createElement('p');
    title.className = 'md-alert-title';
    title.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="' + info.icon + '"/></svg>';
    title.appendChild(document.createTextNode(info.label));
    div.appendChild(title);
    while (bq.firstChild) div.appendChild(bq.firstChild);
    bq.replaceWith(div);
  }
}

function windowsPathFrom(src, docDir) {
  // Protocol-relative (//host/…) and UNC (\\host\…) inputs point at a network
  // location; resolving one would leak the user's credentials over SMB, so they
  // are never treated as local media. See the matching guard in main.cpp.
  if (/^[\\/]{2}/.test(src)) return null;
  let p = src;
  const fileUrl = p.match(/^file:\/\/(.*)$/i);
  if (fileUrl) {
    p = decodeURIComponent(fileUrl[1]);
    p = p.replace(/^\/+([A-Za-z]:)/, '$1');       // file:///C:/x -> C:/x
    if (!/^[A-Za-z]:/.test(p)) return null;       // file://server/share -> network, refuse
  }
  p = p.replace(/\//g, '\\');
  const isAbs = /^[A-Za-z]:\\/.test(p);
  if (!isAbs) {
    if (p.startsWith('\\')) return null;          // any remaining rooted/UNC form
    if (!docDir) return null;
    p = docDir + '\\' + p;
  }
  const parts = [];
  for (const seg of p.replace(/^\\+/, '').split('\\')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length > 1) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('\\');
}

function toDocUrl(winPath) {
  return 'https://doc.local/__abs__/' + encodeURIComponent(winPath);
}

// A real, standard file:// URI for a heading in a document on disk (used by
// the "copy link to heading" anchors in decorate()). Only the drive letter
// segment is left unescaped -- it's already URI-safe and escaping its own
// ':' would be technically valid but needlessly ugly for something meant to
// be pasted somewhere and read.
function fileUrlForHeading(winPath, headingId) {
  const parts = winPath.replace(/\\/g, '/').split('/');
  const encoded = parts.map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/');
  return 'file:///' + encoded + '#' + encodeURIComponent(headingId);
}

// markdown-it percent-encodes link/image destinations it renders from markdown
// syntax (a space becomes %20), so windowsPathFrom must decode before treating
// the value as a filesystem path, matching how main.cpp's __abs__ handler does
// exactly one UrlDecode. Raw inline HTML the document author wrote by hand
// bypasses that encoding step, though, and can contain a literal "%" that
// isn't a valid escape (a real screenshot filename like "Progress 50%.png") —
// decodeURIComponent throws on that, which would otherwise take the whole
// render down. Fail open: keep the original string rather than crash.
function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

const MD_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|rmd|qmd)$/i;

function decorate(root, docDir) {
  // DOMPurify allows data-* attributes by default (PURIFY_CFG never sets
  // ALLOW_DATA_ATTR: false), and the link loop below only touches <a href>
  // elements — so raw document HTML like <a data-open="//host/share/x.md">
  // (no href needed to be clickable via this app's own click handler) would
  // otherwise reach the native openPath handler exactly as if this trusted
  // code had put it there. Strip first; only this function may set it.
  for (const a of root.querySelectorAll('a')) {
    delete a.dataset.open;
    delete a.dataset.hash;
  }
  transformAlerts(root);

  // resolve local media (single-URL attributes)
  const isRemote = (v) => /^(https?:|data:|blob:|#)/i.test(v);
  for (const el of root.querySelectorAll('img[src], video[src], audio[src], source[src], video[poster], track[src]')) {
    for (const attr of ['src', 'poster']) {
      const v = el.getAttribute(attr);
      if (!v || isRemote(v)) continue;
      const wp = windowsPathFrom(safeDecodeURIComponent(v), docDir);
      if (wp) el.setAttribute(attr, toDocUrl(wp));
    }
  }
  // srcset candidate lists ("url 1x, url 2x") on img and <source>
  for (const el of root.querySelectorAll('img[srcset], source[srcset]')) {
    const rewritten = el.getAttribute('srcset').split(',').map((cand) => {
      const m = cand.trim().match(/^(\S+)(\s+.*)?$/);
      if (!m || isRemote(m[1])) return cand.trim();
      const wp = windowsPathFrom(safeDecodeURIComponent(m[1]), docDir);
      return (wp ? toDocUrl(wp) : m[1]) + (m[2] || '');
    }).join(', ');
    el.setAttribute('srcset', rewritten);
  }
  for (const img of root.querySelectorAll('img')) {
    img.loading = 'lazy';
  }

  // links
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) {
      a.classList.add('external');
      if (!a.title) a.title = href + ' (opens in your browser)';
      continue;
    }
    if (href.startsWith('#')) continue;
    const hashIdx = href.indexOf('#');
    const filePart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
    const hashPart = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';
    const wp = windowsPathFrom(safeDecodeURIComponent(filePart), docDir);
    if (wp) {
      a.dataset.open = wp;
      if (hashPart) a.dataset.hash = hashPart;
      if (MD_EXT.test(wp)) a.title = wp + ' (opens in MD Viewer)';
    }
  }

  // tables: horizontal scroll containers
  for (const table of root.querySelectorAll('table')) {
    if (table.parentElement && table.parentElement.classList.contains('table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Table');
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }

  // code blocks: language label + copy button
  for (const pre of root.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const langMatch = (code.className || '').match(/language-([\w+-]+)/);
    const bar = document.createElement('div');
    bar.className = 'codebar';
    if (langMatch) {
      const lang = document.createElement('span');
      lang.className = 'codelang';
      lang.textContent = langMatch[1];
      bar.appendChild(lang);
    }
    const btn = document.createElement('button');
    btn.className = 'copybtn';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    bar.appendChild(btn);
    pre.appendChild(bar);
  }

  // heading anchors + focusability for heading navigation
  for (const h of root.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')) {
    h.tabIndex = -1;
    const a = document.createElement('a');
    a.className = 'hanchor';
    // A real file:// URI when this is a genuine document on disk, not just
    // "#id" -- WebView2's context menu already keeps "Copy link location"
    // (main.cpp), so right-clicking this now copies something actually
    // portable (a reference to this exact heading in this exact file)
    // instead of app.local's own meaningless internal URL. data-heading is
    // what the click handler below actually acts on, so a plain scroll-in-
    // place still works regardless of what the href resolves to.
    a.href = doc.path ? fileUrlForHeading(doc.path, h.id) : '#' + h.id;
    a.dataset.heading = h.id;
    a.textContent = '#';
    a.setAttribute('aria-label', 'Link to section: ' + h.textContent);
    h.prepend(a);
  }

  // ```math fences → KaTeX display blocks (GitHub-style)
  if (window.katex) {
    for (const code of root.querySelectorAll('pre > code.language-math')) {
      const pre = code.parentElement;
      const div = document.createElement('div');
      div.className = 'math-block';
      try {
        katex.render(code.textContent, div, { displayMode: true, throwOnError: false });
        pre.replaceWith(div);
      } catch (e) { /* leave the fence as code */ }
    }
  }

  // ```mermaid fences → placeholders, rendered async by renderMermaids()
  for (const code of root.querySelectorAll('pre > code.language-mermaid')) {
    const pre = code.parentElement;
    const fig = document.createElement('figure');
    fig.className = 'mermaid-fig pending';
    fig.dataset.src = code.textContent;
    fig.setAttribute('role', 'img');
    const firstLine = (code.textContent.trim().split('\n')[0] || 'diagram').slice(0, 80);
    fig.setAttribute('aria-label', 'Diagram: ' + firstLine);
    pre.replaceWith(fig);
  }

  // [TOC] / [[toc]] paragraph markers → inline table of contents. Require a
  // plain-text paragraph so that `[TOC]` in a code span (or otherwise marked up)
  // stays literal and can be documented. The heading list itself is filled in
  // by fillPendingTocMarkers() once the whole document is present — headings
  // this marker should list may not have arrived yet when a large document is
  // still streaming in chunk by chunk.
  for (const p of Array.from(root.querySelectorAll('p'))) {
    if (p.children.length) continue;
    const t = p.textContent.trim().toLowerCase();
    if (t !== '[toc]' && t !== '[[toc]]') continue;
    const nav = document.createElement('nav');
    nav.className = 'inline-toc';
    nav.dataset.pending = '1';
    nav.setAttribute('aria-label', 'Table of contents');
    nav.appendChild(document.createElement('ul'));
    p.replaceWith(nav);
  }

  // neutralize any stray form inputs from raw HTML, EXCEPT the real
  // task-list checkboxes markdown-it-task-lists itself generated (now
  // genuinely interactive -- see the change listener on content below --
  // rather than always force-disabled the way every other checkbox/radio
  // still is here).
  for (const input of root.querySelectorAll('input')) {
    if (input.classList.contains('task-list-item-checkbox')) continue;
    if (input.type === 'checkbox' || input.type === 'radio') input.disabled = true;
    else input.remove();
  }
}

// Populate every [TOC] marker's heading list from the *whole* document.
// Call once the full document (all chunks, for progressive rendering) is in
// the DOM — see the comment on the marker's creation in decorate() above.
function fillPendingTocMarkers() {
  const pending = content.querySelectorAll('nav.inline-toc[data-pending]');
  if (!pending.length) return;
  const heads = content.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
  const items = [];
  for (const h of heads) {
    if (h.closest('.footnotes')) continue;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent.replace(/^#\s*/, '');
    a.dataset.lvl = h.tagName[1];
    li.appendChild(a);
    items.push(li);
  }
  for (const nav of pending) {
    const ul = nav.querySelector('ul');
    ul.append(...items.map((li) => li.cloneNode(true)));
    delete nav.dataset.pending;
  }
}

/* ---------------- large-document rendering: off-thread + time-sliced ----------------

   Markdown-it's parse/render, syntax highlighting, and KaTeX's string output
   are pure computation with no DOM dependency (the shared config lives in
   md-setup.js, loaded by both this page and worker.js), so for a document
   large enough for that to matter, the whole thing runs on a Worker instead
   of blocking this thread. The HTML it hands back is then written into
   #content in small time-sliced batches: a fixed millisecond budget of work,
   then hand control back to the event loop and pick up again on the next
   macrotask (a real animation frame every so often, so paint isn't starved —
   see SLICE_BUDGET_MS / PAINT_INTERVAL_MS below for why it's built this way
   and not the more obvious pure-requestAnimationFrame loop). A huge document
   never produces one long blocking DOM write; the page stays scrollable and
   responsive throughout, and the reader sees it fill in top to bottom in
   real time rather than freezing until it's entirely ready.

   Below this size, the original single synchronous md.render() + one
   sanitize + one innerHTML write runs exactly as it always has — a worker
   round-trip has its own overhead, and a document this size renders in a
   handful of milliseconds either way. */

const PROGRESSIVE_THRESHOLD = 50000;   // body length, in characters
// Work done per slice before handing the thread back. Sized to stay well
// inside the ~100ms window where input still feels immediate, while being
// large enough that per-slice overhead doesn't dominate: measured across the
// test corpus, 8ms spent more time yielding than working and 32ms cut total
// insertion time by roughly half, with no further gain past that.
const SLICE_BUDGET_MS = BOOT.frameBudget > 0 ? BOOT.frameBudget : 32;
// Take a real animation frame at least this often while filling, rather than
// yielding purely to the event loop. This is not only about showing progress:
// restricting the forced frames to the first few chunks (on the theory that
// paint below the fold buys nothing) measured *slower* across the corpus, by
// 25-40% on table- and code-heavy documents. Letting frames happen keeps
// style and layout incremental; suppressing them defers that work until it
// lands in one large batch at the end, which costs more than it saves.
const PAINT_INTERVAL_MS = 50;
const WORKER_TIMEOUT_MS = 20000;

// The worker is kept alive and reused across documents rather than torn down
// after each render: it's stateless between calls (see worker.js's header),
// so there's nothing incorrect about reusing it, and creating a fresh one
// means re-running importScripts on markdown-it, KaTeX, highlight.js and
// every language pack from scratch — real, avoidable cost on every large
// document a session opens after the first. It's still strictly one render
// at a time: a newer request that arrives while the worker is still busy
// terminates it outright (mid-computation state can't be salvaged) and
// starts fresh, exactly as before.
let renderWorker = null;
let workerBusy = false;
let workerCancelPending = null;   // resolves the in-flight promise when superseded, so it doesn't sit until WORKER_TIMEOUT_MS
let lastRenderPath = 'sync', lastChunkCount = 0;   // diagnostics only — see debugRenderComplete()

function terminateRenderWorker() {
  if (workerCancelPending) { const cancel = workerCancelPending; workerCancelPending = null; cancel(); }
  if (renderWorker) { renderWorker.terminate(); renderWorker = null; }
  workerBusy = false;
}

// Write markdown source into #content, choosing the off-thread/time-sliced
// path or the direct synchronous one. `gen` is the docGeneration this call
// belongs to; if a newer document starts loading before this one finishes,
// every remaining step quietly bails rather than corrupting the new one's DOM.
async function renderMarkdownInto(text, dir) {
  debugTimingReset();   // every render starts its own clean tally, not just --mdv-repeat's
  const { body, fm } = splitFrontMatter(text);
  const gen = docGeneration;
  content.innerHTML = '';
  // A large document can take a user-perceptible amount of time to fill in
  // (see the progressive path below) — without this, a screen reader user
  // who moves into #content mid-render has no way to know it's still
  // incomplete and hears only however much has landed so far. Cleared only
  // at the bottom of this function, and only when this render is the one
  // that actually finishes (a superseded call bails before reaching it,
  // leaving whichever render *is* still in flight to clear it itself).
  content.setAttribute('aria-busy', 'true');

  let handled = false;
  if (body.length >= PROGRESSIVE_THRESHOLD && typeof Worker === 'function') {
    handled = await renderMarkdownProgressive(body, dir, gen);
  }
  if (gen !== docGeneration) return;

  if (!handled) {
    lastRenderPath = 'sync';
    lastChunkCount = 0;
    let t = performance.now();
    const rendered = md.render(body);
    debugTime('mdRender', performance.now() - t);
    t = performance.now();
    const frag = DOMPurify.sanitize(rendered, PURIFY_CFG_FRAGMENT);
    debugTime('sanitize', performance.now() - t);
    if (gen !== docGeneration) return;
    t = performance.now();
    decorate(frag, dir);
    debugTime('decorate', performance.now() - t);
    t = performance.now();
    content.appendChild(frag);
    debugTime('domWrite', performance.now() - t);
  }

  fillPendingTocMarkers();
  if (fm) content.prepend(buildFrontMatter(fm));
  content.setAttribute('aria-busy', 'false');
}

// Returns true if the worker produced a usable result and it's been written
// in (fully, by the time this resolves); false means the caller should fall
// back to the synchronous path.
async function renderMarkdownProgressive(body, dir, gen) {
  if (workerBusy) terminateRenderWorker();   // an earlier render is still in flight; can't safely reuse mid-computation
  if (!renderWorker) renderWorker = new Worker('worker.js');
  const worker = renderWorker;
  workerBusy = true;

  const workerStart = performance.now();
  const result = await new Promise((resolve) => {
    let done = false;
    // On success the worker is left running for the next document to reuse.
    // On error or timeout it's terminated instead — safer than trusting a
    // worker that's just thrown or gone unresponsive to still be in a good
    // state for the next request.
    const finish = (v, reuse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      workerCancelPending = null;
      workerBusy = false;
      if (!reuse) { worker.terminate(); if (renderWorker === worker) renderWorker = null; }
      resolve(v);
    };
    workerCancelPending = () => finish(null, false);
    const timer = setTimeout(() => finish(null, false), WORKER_TIMEOUT_MS);
    worker.onmessage = (e) => finish(e.data, true);
    // preventDefault: this failure is already handled below (fall back, or a
    // no-op if terminateRenderWorker() already resolved this same promise) —
    // without it the error also bubbles to window.onerror, so a superseded
    // worker's importScripts abort would additionally log as an uncaught
    // page error for something that was never actually unhandled.
    worker.onerror = (e) => { e.preventDefault(); finish(null, false); };
    worker.postMessage({ text: body });
  });

  if (gen !== docGeneration) return true;   // superseded; don't touch the new document's DOM — and
                                             // don't record timing for work whose result is discarded
  if (!result || !result.ok || !Array.isArray(result.chunks)) return false;

  debugTime('workerRoundTrip', performance.now() - workerStart);
  if (typeof result.ms === 'number') debugTime('workerCompute', result.ms);

  lastRenderPath = 'progressive';
  lastChunkCount = result.chunks.length;
  const insertStart = performance.now();
  await insertChunksTimeSliced(result.chunks, dir, gen);
  debugTime('chunkInsert', performance.now() - insertStart);
  if (gen === docGeneration) renderMermaids();
  return true;
}

// Hand control back to the event loop between batches. requestAnimationFrame
// is the obvious choice and the wrong one: it resumes at the *next frame*, so
// finishing a batch early idles the thread for the rest of the current frame
// even with work ready to go — measured at roughly two thirds of total
// insertion time spent waiting rather than working. A MessageChannel yield
// resumes on the next macrotask instead, which still lets queued input and
// the browser's own rendering run, but without the fixed frame-clock wait.
const yieldChannel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
let yieldQueue = [];
if (yieldChannel) {
  yieldChannel.port1.onmessage = () => { const fns = yieldQueue; yieldQueue = []; for (const fn of fns) fn(); };
}
function yieldToEventLoop(fn) {
  if (!yieldChannel) { requestAnimationFrame(fn); return; }
  yieldQueue.push(fn);
  yieldChannel.port2.postMessage(0);
}

function insertChunksTimeSliced(chunks, dir, gen) {
  return new Promise((resolve) => {
    let i = 0;
    let lastPaint = performance.now();
    function step() {
      if (gen !== docGeneration) { resolve(); return; }
      const frameStart = performance.now();
      while (i < chunks.length && performance.now() - frameStart < SLICE_BUDGET_MS) {
        let t = performance.now();
        const frag = DOMPurify.sanitize(chunks[i], PURIFY_CFG_FRAGMENT);
        debugTime('sanitize', performance.now() - t);
        t = performance.now();
        decorate(frag, dir);
        debugTime('decorate', performance.now() - t);
        t = performance.now();
        content.append(frag);
        debugTime('domWrite', performance.now() - t);
        i++;
      }
      if (i >= chunks.length) { resolve(); return; }
      // Back-to-back macrotasks can starve the rendering pipeline, which would
      // turn "fills in as you watch" into "blank, then everything at once".
      // Take a real frame periodically so paint is guaranteed a turn, and run
      // flat out the rest of the time.
      const now = performance.now();
      if (now - lastPaint >= PAINT_INTERVAL_MS) {
        lastPaint = now;
        requestAnimationFrame(step);
      } else {
        yieldToEventLoop(step);
      }
    }
    // The first batch still waits for a frame: it lands in a #content that was
    // just emptied, and painting that blank state before filling it is what
    // makes the transition read as progressive rather than as a flash.
    requestAnimationFrame(step);
  });
}

/* ---------------- mermaid diagrams (lazy-loaded, theme-aware) ---------------- */

let mermaidSeq = 0;
let mermaidLoading = null;
let mermaidTheme = null;
let docGeneration = 0;         // bumped whenever a new document renders
let pendingScrollTarget = null; // scrollTop to re-apply after async diagram layout
let pendingScrollHash = null;   // or an anchor id to re-jump to
let suppressRemember = false;   // don't persist scroll while a restore is settling

function ensureMermaid() {
  if (window.mermaid) return Promise.resolve();
  if (!mermaidLoading) {
    mermaidLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/mermaid.min.js';
      s.onload = resolve;
      s.onerror = () => { mermaidLoading = null; reject(new Error('failed to load diagram engine')); };
      document.head.appendChild(s);
    });
  }
  return mermaidLoading;
}

function showDiagramError(fig, src, message) {
  fig.classList.remove('pending');
  fig.classList.add('diagram-error');
  fig.textContent = '';
  // role="img" and its aria-label were set at decorate()-time assuming a
  // successful SVG render; per the ARIA spec, role="img" makes ALL of an
  // element's descendants presentational (excluded from the accessibility
  // tree), so leaving it in place here would silently hide the fallback
  // content below -- a sighted user sees the failure note and raw diagram
  // source, a screen reader user would hear only the original generic
  // "Diagram: ..." label and nothing else. This is real text now, not an
  // image, so the image semantics need to come off first.
  fig.removeAttribute('role');
  fig.removeAttribute('aria-label');
  const note = document.createElement('p');
  note.className = 'diagram-error-note';
  note.textContent = message;
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = src;
  pre.appendChild(code);
  fig.append(note, pre);
}

// The generation (docGeneration) currently holding the render lock, or -1
// if none -- NOT a plain boolean. A plain shared flag has a real race an
// ESLint require-atomic-updates pass surfaced: if document A's render is
// still in flight (awaiting ensureMermaid()/mermaid.render()) when document
// B supersedes it, A's own eventual "I've been superseded, clean up" exit
// path would unconditionally clear the flag -- including while B's own,
// genuinely-still-active render is using it, incorrectly signaling "nothing
// is busy" and letting a third caller start a THIRD overlapping render.
// Tracking which generation owns the lock means a stale generation's
// cleanup only ever clears its OWN claim (`mermaidBusyGen === gen` guards
// every reset below), never a newer one's -- and, as a direct consequence,
// document B is never blocked by A's staleness in the first place (the
// entry guard below compares against the CURRENT generation, not a global
// flag), so B's diagrams can never be silently dropped by this race either.
let mermaidBusyGen = -1;

async function renderMermaids() {
  // The progressive render path kicks this off itself once its chunks are
  // in, and renderDocument() also calls it unconditionally afterward as a
  // catch-all (unchanged, for the plain synchronous-render path) — at most
  // one of those calls should actually be doing mermaid.render() work for a
  // given document at a time, since interleaving two in-flight renders for
  // the SAME generation isn't guaranteed safe. This must reset once the
  // call finishes (on every exit path below), not latch permanently — it
  // needs to allow a *later*, separate call for the same document (e.g. a
  // theme change re-rendering already-drawn diagrams, well after the
  // initial render completed), just not an *overlapping* one.
  if (mermaidBusyGen === docGeneration) return;
  // .pending (not .mermaid-fig) so repeat calls only pick up diagrams that
  // are newly pending — either just streamed in, or just reset for a
  // re-theme (see applyPrefs()) — not ones already rendered.
  const figs = content.querySelectorAll('.mermaid-fig.pending');
  if (!figs.length) return;
  const gen = docGeneration;
  mermaidBusyGen = gen;
  try {
    await ensureMermaid();
  } catch (e) {
    // Engine unavailable: reveal each diagram's source rather than a spinner.
    if (gen === docGeneration)
      figs.forEach((f) => showDiagramError(f, f.dataset.src || '',
        'Diagram engine could not be loaded; showing source.'));
    if (mermaidBusyGen === gen) mermaidBusyGen = -1;
    suppressRemember = false;
    debugMermaidsSettled();
    return;
  }
  // a newer document superseded this run
  if (gen !== docGeneration) { if (mermaidBusyGen === gen) mermaidBusyGen = -1; debugMermaidsSettled(); return; }
  mermaidTheme = isDark ? 'dark' : 'default';
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: mermaidTheme,
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", sans-serif'
  });
  for (const fig of figs) {
    if (gen !== docGeneration || !fig.isConnected) { if (mermaidBusyGen === gen) mermaidBusyGen = -1; debugMermaidsSettled(); return; }
    const src = fig.dataset.src || '';
    const id = 'mdv-mmd-' + (++mermaidSeq);
    try {
      const { svg } = await window.mermaid.render(id, src);
      if (gen !== docGeneration || !fig.isConnected) { if (mermaidBusyGen === gen) mermaidBusyGen = -1; debugMermaidsSettled(); return; }
      fig.innerHTML = svg;
      fig.classList.remove('pending', 'diagram-error');
      // decorate() only stamps role="img"/aria-label once, at initial
      // creation -- a diagram that failed on an earlier pass (which strips
      // both, so the fallback text isn't hidden from screen readers -- see
      // showDiagramError()) and then succeeds on a later one (theme changes
      // reset already-rendered diagrams back to pending and retry them)
      // would otherwise end up a real image with no accessible name at
      // all. Re-stamping here on every success makes this path
      // self-sufficient instead of depending on a stamp made once
      // elsewhere, so it's correct regardless of how many fail/succeed
      // cycles a given diagram has been through.
      fig.setAttribute('role', 'img');
      const firstLine = (src.trim().split('\n')[0] || 'diagram').slice(0, 80);
      fig.setAttribute('aria-label', 'Diagram: ' + firstLine);
    } catch (e) {
      showDiagramError(fig, src, 'Diagram could not be rendered: ' + String((e && e.message) || e));
      const stray = document.getElementById('d' + id);
      if (stray) stray.remove();
    }
  }
  if (mermaidBusyGen === gen) mermaidBusyGen = -1;
  if (gen !== docGeneration) { debugMermaidsSettled(); return; }
  // Diagrams changed layout after the synchronous render; re-apply the pending
  // scroll intent and rebuild any active search over the new DOM.
  if (pendingScrollHash) gotoHash('#' + pendingScrollHash, false);
  else if (pendingScrollTarget != null) main.scrollTop = pendingScrollTarget;
  suppressRemember = false;
  if (searchOpen && lastQuery) runSearch(lastQuery, true);
  updateProgress();
  debugMermaidsSettled();
}

/* ================================================================ document state */

const doc = {
  kind: 'none',       // none | file | demo
  path: '', dir: '', name: '', plain: false,
  untitled: false,    // a new document with nowhere to save yet
  source: '',         // the raw Markdown behind the rendered view
  pendingHash: ''
};

/* ---------------- navigation history ----------------
   One stack covering both document switches and in-document jumps (table of
   contents, anchor links, typed page numbers), so Back always returns the
   reader to exactly where they were — the way a browser behaves. Callers
   snapshot the outgoing position with navSnapshot() *before* the DOM or scroll
   changes, then push the new entry. */

const navHist = { entries: [], idx: -1 };
let pendingHistScroll = null;   // scroll to apply after a cross-document history load
// navGo() advances navHist.idx optimistically, before the async cross-document
// open it triggers is known to succeed — openFailed uses this to put idx back
// where it was rather than leaving it pointing at an entry that was never
// actually reached.
let pendingHistRevertIdx = null;

function navCurrent() { return navHist.idx >= 0 ? navHist.entries[navHist.idx] : null; }

function navSnapshot() {
  const e = navCurrent();
  if (e && e.kind !== 'welcome') e.scroll = Math.round(main.scrollTop);
}

function navPush(entry) {
  navHist.entries.splice(navHist.idx + 1);
  navHist.entries.push(entry);
  if (navHist.entries.length > 60) navHist.entries.shift();
  navHist.idx = navHist.entries.length - 1;
  updateNavButtons();
}

// An in-document jump: remember where we were, then record the destination.
function navJump(opts) {
  if (doc.kind === 'none') return;
  navSnapshot();
  navPush({
    kind: doc.kind,
    path: doc.path,
    hash: opts.hash || null,
    scroll: opts.scroll != null ? Math.round(opts.scroll) : null
  });
}

function navGo(delta) {
  const i = navHist.idx + delta;
  if (i < 0 || i >= navHist.entries.length) return;
  const dest = navHist.entries[i];
  const leavingDoc = dest.kind !== doc.kind || (dest.kind === 'file' && dest.path !== doc.path);
  if (leavingDoc && !confirmDiscard('Leaving this file will discard them.')) return;
  const fromIdx = navHist.idx;
  navSnapshot();
  navHist.idx = i;
  const e = navHist.entries[i];
  updateNavButtons();

  const sameDoc = e.kind === doc.kind && (e.kind !== 'file' || e.path === doc.path);
  if (!sameDoc) {
    pendingHistScroll = e.scroll != null ? e.scroll : 0;
    if (e.kind === 'file') {
      // openPath is async and can fail (deleted/renamed/locked file) — give
      // openFailed a way to put idx back rather than leaving it pointing at
      // an entry whose document was never actually reached.
      pendingHistRevertIdx = fromIdx;
      post({ type: 'openPath', path: e.path, nav: 'hist' });
    }
    else if (e.kind === 'demo') loadDemo('hist');
    else showWelcome('hist');
    return;
  }
  if (e.kind === 'welcome') return;
  if (e.scroll != null) main.scrollTop = e.scroll;
  else if (e.hash) scrollToId(e.hash);
  main.focus({ preventScroll: true });
  updateProgress();
  say((delta < 0 ? 'Back to ' : 'Forward to ') + describeLocation());
}

function updateNavButtons() {
  $('btn-back').disabled = navHist.idx <= 0;
  $('btn-fwd').disabled = navHist.idx >= navHist.entries.length - 1;
}

// A short spoken description of where the reader has landed.
function describeLocation() {
  const i = currentHeadingIndex();
  if (i >= 0) return headings[i].textContent.replace(/^#\s*/, '');
  return main.scrollTop < 4 ? 'the top of the document' : 'page ' + pageCurrent;
}

function setDocTitle(text, pathTip) {
  $('doctitle-text').textContent = text;
  $('doctitle').title = pathTip || text;
}

function updateRecent(path, name) {
  S.recent = S.recent.filter((r) => r.path !== path);
  S.recent.unshift({ path, name });
  S.recent = S.recent.slice(0, 8);
  save();
  renderRecent();
}

function rememberPosition() {
  if (suppressRemember || editing) return;   // don't let editing overwrite the reading position
  if (doc.kind !== 'file' || !doc.path) return;
  // Delete-then-reinsert so the key lands at the end of insertion order --
  // that makes keys[0] below the *least-recently-touched* entry (true LRU),
  // not just whichever path happened to be remembered first.
  delete S.positions[doc.path];
  S.positions[doc.path] = Math.round(main.scrollTop);
  const keys = Object.keys(S.positions);
  if (keys.length > 40) delete S.positions[keys[0]];
  save();
}

/* ================================================================ rendering */

function showWelcome(nav) {
  navSnapshot();               // capture the outgoing position before the DOM goes
  doc.kind = 'none';
  content.innerHTML = '';
  content.hidden = true;
  welcome.hidden = false;
  editor.hidden = true;
  editing = false;
  $('statusbar').hidden = true;
  updateEditUI();
  setDocTitle('MD Viewer');
  post({ type: 'title', text: 'Welcome' });
  buildToc();
  applySidebar(false);
  clearSearch(true);
  renderRecent();
  if (nav !== 'hist') navPush({ kind: 'welcome' });
  updateNavButtons();
  $('btn-open').focus({ preventScroll: true });
}

async function renderDocument(text, meta) {
  const renderStart = performance.now();
  const prevScroll = main.scrollTop;
  navSnapshot();               // capture the outgoing position before the DOM is replaced
  docGeneration++;
  pendingScrollTarget = null;
  pendingScrollHash = null;
  suppressRemember = true;
  welcome.hidden = true;
  content.hidden = false;

  // Anything but a preview of in-progress edits means we're showing a fresh
  // copy from disk, so leave the editor and drop the dirty flag.
  if (meta.nav !== 'preview') {
    if (editing) { editing = false; post({ type: 'editing', on: '0' }); }
    editor.hidden = true;
    if (dirty) setDirty(false);
  }

  doc.kind = meta.kind;
  doc.path = meta.path || '';
  doc.dir = meta.dir || '';
  doc.name = meta.name || '';
  doc.plain = meta.plain === '1';
  doc.untitled = meta.kind === 'file' && !doc.path;   // a new document, not yet on disk
  // Document info (F1 panel) -- native-authoritative, display only. Falls
  // back to sane defaults for the feature-tour demo (not a real file) and
  // any other caller that doesn't carry these (meta.nav !== 'preview' is the
  // only real-file path that always does).
  doc.bom = meta.bom === '1';
  doc.crlf = meta.crlf === '1';
  doc.encoding = meta.encoding || 'UTF-8';
  doc.size = meta.size != null ? Number(meta.size) : 0;
  doc.modified = meta.modified != null ? Number(meta.modified) : 0;
  doc.source = text;
  if (meta.nav !== 'preview') savedText = text;

  const gen = docGeneration;
  content.innerHTML = '';
  if (doc.plain) {
    const pre = document.createElement('pre');
    pre.className = 'plainview';
    pre.textContent = text;
    content.appendChild(pre);
  } else {
    await renderMarkdownInto(text, doc.dir);
  }
  if (gen !== docGeneration) return;   // a newer document started loading while this one rendered
  // Everything below this point, including every main.scrollTop assignment
  // further down, only ever runs once we've confirmed THIS render is still
  // the current one -- ESLint's require-atomic-updates can't see that the
  // guard above already rules out a stale invocation clobbering `main`
  // (a single, persistent DOM element, never swapped out from under a
  // concurrent render) with an outdated scroll target.

  setDocTitle(doc.name, doc.path);
  buildToc();
  applySidebar(false);
  $('statusbar').hidden = false;
  updateDocStats();
  updateEditUI();

  const nav = meta.nav || 'new';
  if (nav === 'reload' || nav === 'preview') {
    // eslint-disable-next-line require-atomic-updates -- see the gen-check comment above
    main.scrollTop = prevScroll;
    pendingScrollTarget = prevScroll;
    if (nav === 'reload') toast('Reloaded — the file changed on disk.');
  } else {
    // A history navigation carries the exact position to return to.
    const histScroll = nav === 'hist' && pendingHistScroll != null ? pendingHistScroll : null;
    pendingHistScroll = null;
    pendingHistRevertIdx = null;   // this load reached its destination; nothing to revert
    if (meta.kind === 'file') {
      if (nav !== 'hist') navPush({ kind: 'file', path: doc.path });
      if (doc.path) updateRecent(doc.path, doc.name);
      const target = histScroll != null ? histScroll : (S.positions[doc.path] || 0);
      // eslint-disable-next-line require-atomic-updates -- see the gen-check comment above
      main.scrollTop = target;
      pendingScrollTarget = target;   // unconditional — target 0 still needs re-pinning after diagrams settle
    } else {
      if (nav !== 'hist') navPush({ kind: 'demo' });
      const target = histScroll != null ? histScroll : 0;
      // eslint-disable-next-line require-atomic-updates -- see the gen-check comment above
      main.scrollTop = target;
      pendingScrollTarget = target;
    }
    main.focus({ preventScroll: true });
    say('Loaded ' + doc.name);
  }
  updateNavButtons();
  if (doc.pendingHash) {
    const h = doc.pendingHash;
    doc.pendingHash = '';
    pendingScrollHash = h;
    pendingScrollTarget = null;
    requestAnimationFrame(() => gotoHash('#' + h, false));
  }
  if (searchOpen && lastQuery) runSearch(lastQuery, true);
  if (content.querySelector('.mermaid-fig')) renderMermaids();
  else suppressRemember = false;
  updateProgress();
  debugRenderComplete(performance.now() - renderStart);

  // --mdv-repeat: the first render above was the cold one; now measure the
  // steady state the same way a reader hitting reload repeatedly would see it.
  if (BOOT.debug && BOOT.repeat > 1 && !doc.plain && meta.nav !== 'preview') {
    debugRunBenchmark(text, doc.dir, BOOT.repeat);
  }
  // meta.nav !== 'preview' excludes the render leaveEdit() triggers when
  // previewing unsaved changes, so this only ever runs once, right after the
  // document's initial load.
  if (BOOT.debug && BOOT.editorTest && meta.nav !== 'preview') {
    debugRunNativeTest();
  }
  // --mdv-rejection-test: deliberately create a genuinely unhandled Promise
  // rejection (no .catch() anywhere) to verify the 'unhandledrejection'
  // listener above actually forwards into the same [js:error] log line the
  // synchronous 'error' listener uses -- every "no uncaught JS errors"
  // check in this whole suite depends on that being true, but nothing had
  // ever deliberately exercised this specific listener to confirm it.
  if (BOOT.debug && BOOT.rejectionTest && meta.nav !== 'preview') {
    Promise.reject(new Error('rejection-test: deliberate unhandledrejection probe'));
  }

  // --mdv-self-token-test: prove the g_docToken guard (main.cpp) with real
  // fetches through the real __self__ handler, right after the first real
  // file open (meta.tok is the current native token at that point).
  if (BOOT.debug && BOOT.selfTokenTest && meta.kind === 'file' && meta.nav !== 'preview') {
    debugRunSelfTokenTest(meta.tok);
  }

  // A brand-new document has nothing to read, so start in the editor.
  if (pendingNewDoc) {
    pendingNewDoc = false;
    enterEdit();
  }
}

function loadDemo(nav) {
  fetch('demo.md?v=' + Date.now())
    .then((r) => r.text())
    .then((text) => {
      post({ type: 'title', text: 'Feature tour' });
      renderDocument(text, { kind: 'demo', name: 'Feature tour', path: '', dir: '', plain: '0', nav: nav || 'new' });
    })
    .catch(() => toast('Could not load the feature tour.'));
}

// meta.tok is native's g_docToken at the moment this 'doc' message was sent
// (main.cpp's SendDocMsg). Round-tripping it on the __self__ request lets
// native tell a request built from THIS message apart from one built from
// an older 'doc' message a newer one has since superseded -- a 409 means
// exactly that: this request is stale, and a fresh one for the current
// document was already sent alongside the message that superseded it, so
// there is nothing to render here.
function fetchAndRenderFile(meta) {
  fetch('https://doc.local/__self__?tok=' + encodeURIComponent(meta.tok || '0'))
    .then((r) => (r.ok ? r.text() : null))
    .then((text) => { if (text != null) renderDocument(text, Object.assign({ kind: 'file' }, meta)); })
    .catch(() => toast('Could not read the document.'));
}

// --mdv-self-token-test (debug-only): two REAL fetches through the real
// __self__ handler -- not a reimplementation of its check -- directly
// proving the g_docToken guard main.cpp's __self__ branch enforces: a stale
// token must be declined (409), and the current one must be served with the
// exact current document text.
async function debugRunSelfTokenTest(tok) {
  const results = [];
  const staleTok = String(Math.max(0, Number(tok) - 1));
  const stale = await fetch('https://doc.local/__self__?tok=' + staleTok).catch(() => null);
  const staleRejected = !!stale && !stale.ok;
  results.push((staleRejected ? 'PASS' : 'FAIL') +
    ' a stale token is declined, not served the current document under it' +
    (stale ? ' status=' + stale.status : ' (fetch itself failed)'));

  const fresh = await fetch('https://doc.local/__self__?tok=' + encodeURIComponent(tok)).catch(() => null);
  const freshOk = !!fresh && fresh.ok;
  const freshText = freshOk ? await fresh.text() : '';
  const freshMatches = freshOk && freshText === doc.source;
  results.push((freshMatches ? 'PASS' : 'FAIL') +
    ' the current token is served with the exact current document text' +
    (fresh ? ' status=' + fresh.status : ' (fetch itself failed)'));

  const failures = results.filter((r) => r.startsWith('FAIL')).length;
  post({ type: 'debugLog', level: 'selfTokenTestComplete',
    text: `n=${results.length} failures=${failures} | ${results.join(' | ')}` });
}

/* ================================================================ table of contents */

let headings = [];
const tocList = $('toc-list');
const sidebar = $('sidebar');
const backdrop = $('sidebar-backdrop');

/* ---------------- outline straight from the source (edit mode) ---------------- */

// Headings parsed out of raw Markdown. Fenced code is skipped so a shell
// comment like `# rm -rf` inside a code block never becomes a section.
// Front matter is skipped too, the same way renderMarkdownInto() already
// keeps it out of the rendered outline (it renders separately, via
// buildFrontMatter()) -- without this, a key: value line immediately
// before front matter's closing --- delimiter reads exactly like a setext
// heading's text with its underline right after, and becomes a bogus
// section. index stays relative to the ORIGINAL full text throughout (the
// skipped prefix length is added back in), since gotoSourceIndex() uses it
// to place the caret in the real, untouched editor content.
function sourceHeadings(text) {
  const { body, fm } = splitFrontMatter(text);
  const skip = fm != null ? text.length - body.length : 0;
  const out = [];
  const lines = body.split('\n');
  let fence = null;
  let fenceLen = 0;   // CommonMark: a closing fence must be >= the opener's length
  let index = skip;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (open) {
      const ch = open[1][0], len = open[1].length;
      if (!fence) { fence = ch; fenceLen = len; }
      else if (fence === ch && len >= fenceLen) { fence = null; fenceLen = 0; }
    } else if (!fence) {
      const atx = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (atx) {
        out.push({ level: atx[1].length, text: atx[2], index });
      } else {
        const next = lines[i + 1];
        // Setext underlines, excluding list items and thematic breaks.
        if (next && line.trim() && !/^\s{0,3}([-*+]|\d+[.)])\s/.test(line) &&
            /^\s{0,3}(=+|-+)\s*$/.test(next)) {
          out.push({ level: next.trim()[0] === '=' ? 1 : 2, text: line.trim(), index });
        }
      }
    }
    index += line.length + 1;
  }
  return out;
}

let editorHeadings = [];

// tocList's <a> elements, cached whenever they're (re)built (buildToc/
// buildEditorToc) instead of every scroll-driven updateProgress()/
// highlightEditorHeading() call re-querying the live DOM -- querySelectorAll
// alone allocated a fresh NodeList every single animation frame during a
// scroll. activeTocIdx tracks which one currently has .active so
// setActiveTocLink only ever touches the (at most two) links whose state
// actually changed, instead of classList.toggle-ing every link every frame.
let tocLinkEls = [];
let activeTocIdx = -1;
function refreshTocLinkCache() {
  tocLinkEls = Array.from(tocList.querySelectorAll('a'));
  activeTocIdx = -1;
  // A fresh outline (new document, or switching between read/edit) starts
  // unfiltered -- carrying over a stale query from a different document's
  // section list would be confusing, and could hide every single entry of
  // one that happens to share no section titles with the search term.
  // Collapse state resets the same way, for the same reason.
  $('toc-filter').value = '';
  applyTocVisibility();
}

// Hides section-list entries that don't match the filter query (substring,
// case-insensitive) or fall under a collapsed ancestor heading, rather than
// rebuilding the list -- tocLinkEls keeps the exact same elements in the
// exact same order either way, so setActiveTocLink()'s indexing is never
// affected by what's currently hidden.
//
// While a filter query is active, collapse is ignored entirely (every
// matching heading is shown, regardless of what's currently folded) --
// otherwise a reader searching for something they forgot was nested under a
// folded heading would just see "No matching sections" instead of finding
// it. Clearing the query restores the fold state exactly as it was, since
// this never touches li.dataset.collapsed itself.
function applyTocVisibility() {
  const q = $('toc-filter').value.trim().toLowerCase();
  const filtering = q.length > 0;
  let anyVisible = false;
  let collapsedAtLevel = null;   // level of the nearest active collapsed ancestor, or null
  for (const li of tocList.children) {
    const lvl = Number(li.querySelector('a').dataset.lvl || '1');
    if (collapsedAtLevel !== null && lvl <= collapsedAtLevel) collapsedAtLevel = null;
    const hiddenByCollapse = !filtering && collapsedAtLevel !== null;
    if (!hiddenByCollapse && li.dataset.collapsed === '1') collapsedAtLevel = lvl;
    const matchesFilter = !filtering || li.textContent.toLowerCase().includes(q);
    const visible = matchesFilter && !hiddenByCollapse;
    li.hidden = !visible;
    if (visible) anyVisible = true;
  }
  $('toc-empty').hidden = anyVisible || tocList.children.length === 0;
}
$('toc-filter').addEventListener('input', applyTocVisibility);
function setActiveTocLink(idx) {
  if (idx !== activeTocIdx) {
    if (activeTocIdx >= 0 && tocLinkEls[activeTocIdx]) tocLinkEls[activeTocIdx].classList.remove('active');
    if (idx >= 0 && tocLinkEls[idx]) tocLinkEls[idx].classList.add('active');
    activeTocIdx = idx;
  }
  return tocLinkEls[idx];
}

// A toggle is only real (enabled) for a heading with at least one deeper
// heading immediately after it, before the next same-or-shallower one --
// computed from the flat, already-ordered list, no tree structure needed.
// Every row still gets one (disabled, invisible) so text stays aligned
// regardless of which particular headings happen to have children.
function makeTocToggle(collapsible) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toc-toggle';
  btn.tabIndex = -1;
  btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  if (!collapsible) { btn.disabled = true; btn.setAttribute('aria-hidden', 'true'); return btn; }
  btn.tabIndex = 0;
  btn.setAttribute('aria-label', 'Collapse section');
  btn.setAttribute('aria-expanded', 'true');
  return btn;
}

function buildEditorToc() {
  editorHeadings = sourceHeadings(editor.value);
  tocList.innerHTML = '';
  for (let i = 0; i < editorHeadings.length; i++) {
    const h = editorHeadings[i];
    const li = document.createElement('li');
    const collapsible = i + 1 < editorHeadings.length && editorHeadings[i + 1].level > h.level;
    li.appendChild(makeTocToggle(collapsible));
    const a = document.createElement('a');
    a.href = '#';
    a.dataset.index = String(h.index);
    a.dataset.lvl = String(h.level);
    a.textContent = h.text || '(untitled section)';
    li.appendChild(a);
    tocList.appendChild(li);
  }
  refreshTocLinkCache();
  applySidebar(false);
}

// Mark the section the caret is sitting in.
function highlightEditorHeading() {
  const caret = editor.selectionStart;
  let idx = -1;
  for (let i = 0; i < editorHeadings.length; i++) {
    if (editorHeadings[i].index <= caret) idx = i;
    else break;
  }
  const active = setActiveTocLink(idx);
  if (idx >= 0 && !sidebar.hidden && active) active.scrollIntoView({ block: 'nearest' });
}

// Put the caret at a source offset and scroll it into view.
function gotoSourceIndex(index) {
  editor.focus();
  editor.setSelectionRange(index, index);
  updateCaretPosition();
  updateProgress();
}

function hasHeadings() {
  return editing ? editorHeadings.length > 0 : headings.length > 0;
}

function buildToc() {
  if (editing) { buildEditorToc(); return; }
  tocList.innerHTML = '';
  headings = Array.from(content.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'))
    .filter((h) => !h.closest('.footnotes'));
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const li = document.createElement('li');
    const lvl = Number(h.tagName[1]);
    const collapsible = i + 1 < headings.length && Number(headings[i + 1].tagName[1]) > lvl;
    li.appendChild(makeTocToggle(collapsible));
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent.replace(/^#\s*/, '');
    a.dataset.lvl = h.tagName[1];
    li.appendChild(a);
    tocList.appendChild(li);
  }
  refreshTocLinkCache();
}

// The section list shows whenever the reader wants it AND the document has
// headings to list; a document without headings gets no empty rail.
function applySidebar(focusIn) {
  const hasAny = hasHeadings();
  const open = S.sidebar && hasAny;
  sidebar.hidden = !open;
  backdrop.hidden = !open || window.innerWidth > 1000;
  const btn = $('btn-toc');
  btn.setAttribute('aria-expanded', String(open));
  btn.disabled = !hasAny;
  // The drag handle only makes sense while the list is docked beside the text.
  $('sidebar-resizer').hidden = !open || window.innerWidth <= 1000;
  if (open && focusIn) {
    const first = tocList.querySelector('a');
    if (first) first.focus();
  }
}

function setSidebar(open, focusIn) {
  S.sidebar = open;
  save();
  applySidebar(focusIn);
}

/* ---------------- sidebar width (drag or arrow keys) ---------------- */

const resizer = $('sidebar-resizer');

function applySidebarWidth(w) {
  const width = Math.round(Math.max(180, Math.min(520, w)));
  S.sidebarWidth = width;
  document.documentElement.style.setProperty('--sidebar-w', width + 'px');
  resizer.setAttribute('aria-valuenow', String(width));
  return width;
}

resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startW = sidebar.getBoundingClientRect().width;
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('dragging');
  document.body.classList.add('resizing');
  const onMove = (ev) => applySidebarWidth(startW + (ev.clientX - startX));
  const onUp = (ev) => {
    resizer.releasePointerCapture(ev.pointerId);
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    resizer.removeEventListener('pointermove', onMove);
    resizer.removeEventListener('pointerup', onUp);
    resizer.removeEventListener('pointercancel', onUp);
    save();
    updateProgress();
  };
  resizer.addEventListener('pointermove', onMove);
  resizer.addEventListener('pointerup', onUp);
  resizer.addEventListener('pointercancel', onUp);
});

resizer.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 48 : 16;
  if (e.key === 'ArrowLeft') { e.preventDefault(); applySidebarWidth(S.sidebarWidth - step); save(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); applySidebarWidth(S.sidebarWidth + step); save(); }
  else if (e.key === 'Home') { e.preventDefault(); applySidebarWidth(DEFAULTS.sidebarWidth); save(); }
});
resizer.addEventListener('dblclick', () => { applySidebarWidth(DEFAULTS.sidebarWidth); save(); });

tocList.addEventListener('click', (e) => {
  const toggle = e.target.closest('.toc-toggle');
  if (toggle && !toggle.disabled) {
    const li = toggle.closest('li');
    const collapsed = li.dataset.collapsed === '1';
    li.dataset.collapsed = collapsed ? '' : '1';
    toggle.setAttribute('aria-expanded', String(collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Collapse section' : 'Expand section');
    applyTocVisibility();
    return;
  }
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (editing && a.dataset.index != null) gotoSourceIndex(Number(a.dataset.index));
  else gotoHash(a.getAttribute('href'));
  if (window.innerWidth <= 1000) setSidebar(false);
});
tocList.addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const links = Array.from(tocList.querySelectorAll('a'));
  const i = links.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? links[0]
    : e.key === 'End' ? links[links.length - 1]
    : links[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) next.focus();
});
backdrop.addEventListener('click', () => setSidebar(false));
$('btn-toc').addEventListener('click', () => setSidebar(sidebar.hidden, sidebar.hidden));

function scrollToId(id) {
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ block: 'start' });
  if (typeof target.focus === 'function') {
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  return true;
}

// record === false for restores (history, post-diagram re-anchor), which must
// not themselves become new history entries.
function gotoHash(hash, record) {
  let id;
  try { id = decodeURIComponent(hash.slice(1)); } catch (e) { id = hash.slice(1); }
  if (!document.getElementById(id)) return;
  if (record !== false) navJump({ hash: id });
  scrollToId(id);
}

function currentHeadingIndex() {
  const top = main.scrollTop + 90;
  let idx = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].offsetTop <= top) idx = i;
    else break;
  }
  return idx;
}

function gotoHeading(delta) {
  if (!headings.length) return;
  let i = currentHeadingIndex() + delta;
  i = Math.max(0, Math.min(headings.length - 1, i));
  const h = headings[i];
  h.scrollIntoView({ block: 'start' });
  h.focus({ preventScroll: true });
  say(h.textContent);
}

/* ================================================================ pages

   Markdown has no intrinsic pages, so a "page" here is one screenful of the
   document — the same unit Page Up / Page Down move by, minus a couple of
   lines of overlap so nothing is skipped at the seam. Page numbers therefore
   depend on window size and zoom, exactly like an e-reader. */

const PAGE_OVERLAP = 48;
let pageTotal = 1;
let pageCurrent = 1;

// The text area scrolls itself, so paging and progress must follow whichever
// element is actually holding the content right now.
function scroller() { return editing ? editor : main; }

function pageStep() { return Math.max(120, scroller().clientHeight - PAGE_OVERLAP); }

function computePages() {
  const sc = scroller();
  const maxScroll = Math.max(0, sc.scrollHeight - sc.clientHeight);
  const step = pageStep();
  pageTotal = Math.max(1, Math.ceil(maxScroll / step) + 1);
  pageCurrent = maxScroll - sc.scrollTop < 2
    ? pageTotal                                          // pin the last page at the very bottom
    : Math.min(pageTotal, Math.floor(sc.scrollTop / step) + 1);
}

function goToPage(n, record) {
  computePages();
  const sc = scroller();
  const page = Math.max(1, Math.min(pageTotal, Math.round(n) || 1));
  const maxScroll = Math.max(0, sc.scrollHeight - sc.clientHeight);
  const target = Math.min((page - 1) * pageStep(), maxScroll);
  if (record && !editing) navJump({ scroll: target });
  sc.scrollTop = target;
  sc.focus({ preventScroll: true });
  updateProgress();
  say('Page ' + page + ' of ' + pageTotal);
}

// Word count and reading time, computed once per render and surfaced as the
// tooltip on the progress percentage — there when you want it, invisible
// otherwise.
let docStats = { words: 0, minutes: 1 };
function updateDocStats() {
  const words = countVisibleWords(content);
  docStats = { words, minutes: Math.max(1, Math.round(words / 220)) };
  $('sb-pct').title = words.toLocaleString() + ' words · about ' +
    docStats.minutes + ' min read';
}

function updatePageUI() {
  computePages();
  const input = $('page-input');
  if (document.activeElement !== input) input.value = String(pageCurrent);
  $('page-total').textContent = '/ ' + pageTotal;
  $('page-prev').disabled = pageCurrent <= 1;
  $('page-next').disabled = pageCurrent >= pageTotal;
}

/* ================================================================ scroll: progress, active TOC, position memory */

let scrollRaf = 0;
let posTimer = null;
function updateProgress() {
  const sc = scroller();
  const maxScroll = sc.scrollHeight - sc.clientHeight;
  const pct = maxScroll > 0 ? (sc.scrollTop / maxScroll) * 100 : 0;
  $('progress-fill').style.width = pct + '%';

  if (editing) {
    // The outline and caret readout are driven by the source, not the DOM.
    updatePageUI();
    $('sb-pct').textContent = editorWords.toLocaleString() + ' words';
    highlightEditorHeading();
    return;
  }

  const idx = currentHeadingIndex();
  const active = setActiveTocLink(idx);
  if (idx >= 0 && !sidebar.hidden && active) active.scrollIntoView({ block: 'nearest' });

  if (doc.kind !== 'none') {
    updatePageUI();
    $('sb-pct').textContent = Math.round(pct) + '%';
    const section = idx >= 0 ? headings[idx].textContent.replace(/^#\s*/, '') : '';
    $('sb-section-text').textContent = section;
    $('sb-section').hidden = !section;
  }
}
main.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    updateProgress();
  });
  clearTimeout(posTimer);
  posTimer = setTimeout(rememberPosition, 500);
  hideFootPop();
});

/* ================================================================ search */

const findbar = $('findbar');
const findInput = $('find-input');
const findCount = $('find-count');
let searchOpen = false;
let lastQuery = '';
let matches = [];
let matchIdx = -1;
const supportsHighlight = typeof CSS !== 'undefined' && CSS.highlights;

function openFind() {
  findbar.hidden = false;
  searchOpen = true;
  syncReplaceControls();
  findInput.focus();
  findInput.select();
}

// The replace half of the bar only exists while editing.
function syncReplaceControls() {
  for (const id of ['replace-input', 'replace-one', 'replace-all'])
    $(id).hidden = !editing;
}

function replaceCurrent() {
  if (!editing || matchIdx < 0 || !matches.length) return;
  const hit = matches[matchIdx];
  const text = $('replace-input').value;
  const at = hit.start;
  // Same invariant as every other programmatic edit (see replaceRange's own
  // comment): go through insertText, not setRangeText directly, so a single
  // Replace click still lands on the native undo stack.
  replaceRange(hit.start, hit.end, text, at + text.length);
  // Rebuild the match list over the changed text and land on the next hit.
  matches = collectMatches(lastQuery, findOpts());
  if (!matches.length) { matchIdx = -1; findCount.textContent = 'No results'; say('Replaced. No more matches.'); return; }
  matchIdx = matches.findIndex((m) => m.start >= at + text.length);
  if (matchIdx < 0) matchIdx = 0;
  focusMatch(false);
  say('Replaced. ' + matches.length + ' left.');
}

function replaceAll() {
  if (!editing || !lastQuery) return;
  const hits = collectMatches(lastQuery, findOpts());
  if (!hits.length) { toast('Nothing to replace.'); return; }
  const text = $('replace-input').value;
  let out = '', prev = 0;
  for (const h of hits) { out += editor.value.slice(prev, h.start) + text; prev = h.end; }
  out += editor.value.slice(prev);
  // One replacement of the whole text = one undo step for the whole operation.
  replaceRange(0, editor.value.length, out, Math.min(editor.selectionStart, out.length));
  runSearch(lastQuery, false);
  toast('Replaced ' + hits.length + ' match' + (hits.length === 1 ? '' : 'es') + '.');
}

$('replace-one').addEventListener('click', replaceCurrent);
$('replace-all').addEventListener('click', replaceAll);
$('replace-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? replaceAll() : replaceCurrent(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
function closeFind() {
  findbar.hidden = true;
  searchOpen = false;
  clearSearch(false);
  main.focus({ preventScroll: true });
}
function clearSearch(clearInput) {
  matches = [];
  matchIdx = -1;
  if (supportsHighlight) {
    CSS.highlights.delete('mdv-search');
    CSS.highlights.delete('mdv-search-current');
  }
  findCount.textContent = '';
  if (clearInput) { findInput.value = ''; lastQuery = ''; }
}

// Find options -> one compiled RegExp, shared by every matcher below so
// case/whole-word/regex mode can never disagree between read and edit mode.
// Whole-word wraps in \b regardless of mode (VS Code does the same for a
// user-supplied regex, and it's a no-op for a pattern that already starts/
// ends on a word boundary). Returns { error } instead of throwing so a
// malformed --findRegex pattern degrades to "no matches found", not a crash.
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function buildFindMatcher(query, opts) {
  let source = opts.regex ? query : escapeRegExp(query);
  if (opts.wholeWord) source = '\\b(?:' + source + ')\\b';
  try {
    return { regex: new RegExp(source, 'g' + (opts.caseSensitive ? '' : 'i')) };
  } catch (e) {
    return { error: e.message };
  }
}
function findOpts() {
  return { caseSensitive: S.findCase, wholeWord: S.findWord, regex: S.findRegex };
}

// Runs a compiled matcher over one string, guarding against the infinite
// loop a zero-length match (e.g. a user regex like `x*`) would otherwise
// cause with the global flag's own lastIndex-advance.
function execAll(regex, hay, onMatch) {
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(hay))) {
    onMatch(m.index, m.index + m[0].length);
    regex.lastIndex = m[0].length ? regex.lastIndex : regex.lastIndex + 1;
    if (regex.lastIndex > hay.length) break;
  }
}

// While editing we search the source text and select hits in the text area;
// while reading we walk the rendered DOM and paint them with the highlight API.
function collectEditorMatches(query, opts) {
  const { regex } = buildFindMatcher(query, opts);
  if (!regex) return [];
  const out = [];
  execAll(regex, editor.value, (start, end) => out.push({ start, end }));
  return out;
}

// Shared by collectMatches() (search) and countVisibleWords(): true for a
// text node under #content (or a detached editing-preview element) that's
// actual document PROSE, not decorative UI chrome or duplicate/invisible
// text. Skips copy-bar labels (language name, "Copy"/"Copied ✓"), heading
// anchor icons ("#", prepended inside every heading -- otherwise it counts
// as its own bogus one-character word), mermaid's injected <style>, and
// KaTeX's visually-hidden MathML/TeX source and SVG title/desc nodes.
// Without this, search match counts AND the word count both get inflated
// by text the reader doesn't actually read as part of the document (and
// for KaTeX, text that's really just a duplicate, non-visible copy of a
// formula already counted once via its visible rendering).
function isVisibleContentTextNode(node) {
  if (!node.data.trim()) return false;
  const p = node.parentElement;
  if (!p) return false;
  return !(p.closest('.codebar, .hanchor, style, .katex-mathml') ||
    (p.namespaceURI === 'http://www.w3.org/2000/svg' && /^(style|title|desc)$/i.test(p.nodeName)));
}

// Word count over just the visible text under `root` (#content normally,
// or documentStats()'s own detached editing-preview element) -- shared so
// the status-bar tooltip and the F1 document-info panel can never disagree
// with each other, or with what collectMatches() actually searches.
function countVisibleWords(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => isVisibleContentTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  let text = '';
  let node;
  while ((node = walker.nextNode())) text += node.data + ' ';
  return (text.match(/\S+/g) || []).length;
}

// Block-level containers that bound a search phrase: two text nodes on
// either side of, say, `<strong>` should be searchable as one continuous
// phrase ("**bold** text" matching a search for "bold text"), but two nodes
// in different paragraphs/list items should never silently concatenate into
// a false cross-block match just because nothing separates them in the DOM.
const FIND_BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dt,dd,div,pre,tr,figcaption,summary';

// Maps a position in one block group's concatenated string back to a real
// (node, offset) -- chunks tile the group with no gaps, so any position up
// to and including the group's total length resolves to some chunk.
function posInChunks(chunks, idx) {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (idx < c.end || i === chunks.length - 1) return { node: c.node, offset: Math.min(idx - c.start, c.node.data.length) };
  }
}

function collectMatches(query, opts) {
  if (editing) return collectEditorMatches(query, opts);
  const { regex } = buildFindMatcher(query, opts);
  if (!regex) return [];
  const out = [];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => isVisibleContentTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  let node, block, hay = '', chunks = [];
  const flush = () => {
    if (hay) {
      execAll(regex, hay, (start, end) => {
        const s = posInChunks(chunks, start), e = posInChunks(chunks, end);
        const range = new Range();
        range.setStart(s.node, s.offset);
        range.setEnd(e.node, e.offset);
        out.push(range);
      });
    }
    hay = ''; chunks = [];
  };
  while ((node = walker.nextNode())) {
    const b = node.parentElement ? node.parentElement.closest(FIND_BLOCK_SELECTOR) : null;
    if (b !== block) { flush(); block = b; }
    chunks.push({ node, start: hay.length, end: hay.length + node.data.length });
    hay += node.data;
  }
  flush();
  return out;
}

function runSearch(query, keepIndex) {
  lastQuery = query;
  const prevIdx = matchIdx;
  clearSearch(false);
  if (!query) { say('Search cleared'); return; }
  // Validated separately from collectMatches() itself (which just returns []
  // on a bad pattern) so an invalid --findRegex query gets its own honest
  // message instead of silently looking like "No results".
  const { error } = buildFindMatcher(query, findOpts());
  if (error) {
    findCount.textContent = 'Invalid regex';
    say('Invalid regular expression: ' + error);
    return;
  }
  matches = collectMatches(query, findOpts());
  if (!editing && supportsHighlight && matches.length)
    CSS.highlights.set('mdv-search', new Highlight(...matches));
  if (!matches.length) {
    findCount.textContent = 'No results';
    say('No results for ' + query);
    return;
  }
  matchIdx = keepIndex && prevIdx >= 0 ? Math.min(prevIdx, matches.length - 1) : 0;
  focusMatch(false);
  say(matches.length + ' result' + (matches.length === 1 ? '' : 's'));
}

function focusMatch(scrollSmooth) {
  if (matchIdx < 0 || !matches.length) return;
  if (editing) {
    // Selecting inside a focused text area is what scrolls it, so borrow focus
    // for a moment and hand it straight back to whatever the reader was using.
    const hit = matches[matchIdx];
    const active = document.activeElement;
    editor.focus();
    editor.setSelectionRange(hit.start, hit.end);
    if (active && active !== editor && typeof active.focus === 'function') active.focus();
    findCount.textContent = (matchIdx + 1) + ' / ' + matches.length;
    updateCaretPosition();
    return;
  }
  const range = matches[matchIdx];
  if (supportsHighlight)
    CSS.highlights.set('mdv-search-current', new Highlight(range));
  const rect = range.getBoundingClientRect();
  const mainRect = main.getBoundingClientRect();
  if (rect.top < mainRect.top + 60 || rect.bottom > mainRect.bottom - 60) {
    main.scrollBy({
      top: rect.top - mainRect.top - main.clientHeight / 2,
      behavior: scrollSmooth && document.documentElement.dataset.motion !== 'off' ? 'smooth' : 'auto'
    });
  }
  findCount.textContent = (matchIdx + 1) + ' / ' + matches.length;
}

function findStep(delta) {
  if (!matches.length) { if (lastQuery) say('No results'); return; }
  matchIdx = (matchIdx + delta + matches.length) % matches.length;
  focusMatch(true);
  say('Result ' + (matchIdx + 1) + ' of ' + matches.length);
}

let findTimer = null;
findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => runSearch(findInput.value), 130);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('find-next').addEventListener('click', () => findStep(1));
$('find-prev').addEventListener('click', () => findStep(-1));
$('find-close').addEventListener('click', closeFind);
// Shared by all three find-option toggle buttons (case/whole-word/regex):
// flip the S.* flag, mirror it to aria-pressed, persist, and re-run the
// current query so the toggle's effect is visible immediately.
function bindFindToggle(id, key) {
  $(id).addEventListener('click', () => {
    S[key] = !S[key];
    $(id).setAttribute('aria-pressed', String(S[key]));
    save();
    runSearch(findInput.value);
  });
}
bindFindToggle('find-case', 'findCase');
bindFindToggle('find-word', 'findWord');
bindFindToggle('find-regex', 'findRegex');
$('btn-find').addEventListener('click', openFind);

/* ================================================================ links, copy, lightbox, footnotes */

content.addEventListener('click', (e) => {
  const copy = e.target.closest('.copybtn');
  if (copy) {
    const pre = copy.closest('pre');
    const code = pre && pre.querySelector('code');
    if (code) {
      navigator.clipboard.writeText(code.innerText).then(() => {
        copy.textContent = 'Copied ✓';
        say('Code copied to clipboard');
        setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
      });
    }
    return;
  }
  const img = e.target.closest('img');
  if (img && !e.target.closest('a')) {
    openLightbox(img);
    return;
  }
  const a = e.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (a.dataset.heading) {
    // The href itself is a real file:// URI (see decorate()) so the
    // browser's own "Copy link location" produces something useful on
    // right-click; a left-click still just scrolls in place, same as ever.
    e.preventDefault();
    gotoHash('#' + a.dataset.heading);
    return;
  }
  if (a.dataset.open) {
    e.preventDefault();
    if (!confirmDiscard('Opening another file will discard them.')) return;
    doc.pendingHash = a.dataset.hash || '';
    post({ type: 'openPath', path: a.dataset.open, nav: 'link' });
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    e.preventDefault();
    post({ type: 'openExternal', url: href });
    return;
  }
  if (href.startsWith('#')) {
    e.preventDefault();
    gotoHash(href);
    return;
  }
  e.preventDefault();
});

/* ---------------- task checkboxes (click to toggle, writes back to source) ---------------- */

// Maps each rendered task-list checkbox back to its exact [line, column] in
// the raw source, in the SAME order markdown-it-task-lists itself finds
// them. md.parse() runs the full core rule chain -- including that plugin's
// own pass -- so by the time the tokens come back, each task item's inline
// content has ALREADY been rewritten (the leading "[ ] "/"[x] " replaced
// with <label>/<input>/</label> html_inline children); there's nothing left
// to pattern-match there. What survives untouched is simpler and more
// reliable anyway: the plugin stamps every task item's OWN list_item_open
// token with class="task-list-item" (regardless of the enabled option), and
// that token's .map[0] is the exact source line the item starts on --
// walking those, in document order, finds every task item (nested or
// blockquoted included, since this doesn't depend on nesting depth at all)
// without reimplementing any of CommonMark's block-structure rules.
function sourceTaskItems(text) {
  const tokens = md.parse(text, {});
  const lines = text.split('\n');
  const out = [];
  for (const t of tokens) {
    if (t.type !== 'list_item_open' || !t.map) continue;
    const cls = t.attrGet('class');
    if (!cls || !/(?:^|\s)task-list-item(?:\s|$)/.test(cls)) continue;
    const m = lines[t.map[0]].match(/\[( |x|X)\]/);
    if (!m) continue;
    out.push({ lineNo: t.map[0], col: m.index });
  }
  return out;
}

// Clicking a task checkbox while reading updates doc.source directly and
// marks the document dirty -- same promise as everything else here
// ("nothing is written to disk unless you press Ctrl+S"), just without
// requiring Ctrl+E first for what's otherwise the single most common
// one-off edit a reader makes. editor.value is kept in step too: dirty may
// already be true (this could be a preview of the reader's own unsaved
// edits -- leaveEdit() renders those with nav:'preview', and doc.source and
// editor.value already hold the identical text at that point), and
// enterEdit() reuses editor.value as-is whenever dirty is already true
// rather than reseeding from doc.source -- leaving it unsynced here would
// make a later edit-mode entry silently revert this toggle.
content.addEventListener('change', (e) => {
  const cb = e.target;
  if (!cb.matches || !cb.matches('input.task-list-item-checkbox')) return;
  const boxes = content.querySelectorAll('input.task-list-item-checkbox');
  const idx = Array.prototype.indexOf.call(boxes, cb);
  const items = sourceTaskItems(doc.source);
  if (idx < 0 || idx >= items.length) return;
  const { lineNo, col } = items[idx];
  const lines = doc.source.split('\n');
  const line = lines[lineNo];
  lines[lineNo] = line.slice(0, col + 1) + (cb.checked ? 'x' : ' ') + line.slice(col + 2);
  doc.source = lines.join('\n');
  editor.value = doc.source;
  setDirty(doc.source !== savedText);
});

/* ---------------- lightbox ---------------- */

const lightbox = $('lightbox');
const lightboxImg = $('lightbox-img');
let lightboxReturnFocus = null;
// All images in the CURRENT document, captured fresh each time the lightbox
// opens, and which one is showing -- lets Left/Right (and the prev/next
// buttons) step through them without closing and reopening.
let lightboxImages = [];
let lightboxIndex = -1;

// Zoom/pan state (docs/BACKLOG.md's Features #11). Center-anchored rather
// than cursor-anchored: simpler, deterministic to test, and the modal is
// small enough that the difference is barely perceptible in practice.
const LIGHTBOX_ZOOM_MIN = 1;
const LIGHTBOX_ZOOM_MAX = 4;
let lightboxZoom = 1;
let lightboxPanX = 0;
let lightboxPanY = 0;

function applyLightboxTransform() {
  lightboxImg.style.transform = lightboxZoom === 1 ? '' : `translate(${lightboxPanX}px, ${lightboxPanY}px) scale(${lightboxZoom})`;
  lightboxImg.classList.toggle('zoomed', lightboxZoom > 1);
  $('lightbox-zoom-out').disabled = lightboxZoom <= LIGHTBOX_ZOOM_MIN;
  $('lightbox-zoom-in').disabled = lightboxZoom >= LIGHTBOX_ZOOM_MAX;
  $('lightbox-zoom-reset').disabled = lightboxZoom === 1;
  // Same real bug the prev/next buttons already had (see showLightboxImage's
  // own comment): disabling the currently-focused zoom button at a boundary
  // blurs it straight out of the modal, since a disabled element can't hold
  // focus. Reaching min/max zoom via repeated keyboard/click activation on
  // zoom-out/zoom-in is exactly how a keyboard user would hit this.
  if (!lightbox.contains(document.activeElement)) $('lightbox-close').focus();
}

// Keeps the image from being panned so far that its edge would leave a gap
// inside the modal -- offsetWidth/Height is the pre-transform layout box
// (CSS transform doesn't affect layout), so this is exactly how far a given
// zoom level lets the image legitimately shift in either direction.
function clampLightboxPan() {
  const maxX = (lightboxImg.offsetWidth * (lightboxZoom - 1)) / 2;
  const maxY = (lightboxImg.offsetHeight * (lightboxZoom - 1)) / 2;
  lightboxPanX = Math.max(-maxX, Math.min(maxX, lightboxPanX));
  lightboxPanY = Math.max(-maxY, Math.min(maxY, lightboxPanY));
}

function setLightboxZoom(z) {
  lightboxZoom = Math.max(LIGHTBOX_ZOOM_MIN, Math.min(LIGHTBOX_ZOOM_MAX, z));
  if (lightboxZoom === 1) { lightboxPanX = 0; lightboxPanY = 0; }
  clampLightboxPan();
  applyLightboxTransform();
}

function showLightboxImage() {
  const img = lightboxImages[lightboxIndex];
  lightboxImg.src = img.currentSrc || img.src;
  lightboxImg.alt = img.alt || '';
  $('lightbox-caption').textContent = img.alt || '';
  $('lightbox-prev').disabled = lightboxIndex <= 0;
  $('lightbox-next').disabled = lightboxIndex >= lightboxImages.length - 1;
  setLightboxZoom(1);   // a new image starts unzoomed, regardless of the last one's state
  // Disabling the currently-focused button -- reaching a boundary via click
  // most commonly -- blurs it straight out of the modal entirely, to
  // <body> (a real browser quirk: a disabled element can't hold focus, and
  // this happens synchronously, so by the time this runs activeElement has
  // ALREADY changed -- checking ITS .disabled is always false, since body
  // isn't disabled either). Checking containment instead catches it
  // regardless: silently losing focus here would break every subsequent
  // keyboard interaction, since events would no longer bubble through the
  // lightbox at all once nothing inside it holds focus.
  if (!lightbox.contains(document.activeElement)) $('lightbox-close').focus();
}

function lightboxStep(delta) {
  const next = lightboxIndex + delta;
  if (next < 0 || next >= lightboxImages.length) return;
  lightboxIndex = next;
  showLightboxImage();
}

function openLightbox(img) {
  lightboxImages = Array.from(content.querySelectorAll('img'));
  lightboxIndex = lightboxImages.indexOf(img);
  showLightboxImage();
  lightboxReturnFocus = document.activeElement;
  lightbox.hidden = false;
  $('lightbox-close').focus();
}
function closeLightbox() {
  lightbox.hidden = true;
  lightboxImg.src = '';
  lightboxImages = [];
  lightboxIndex = -1;
  setLightboxZoom(1);
  if (lightboxReturnFocus) lightboxReturnFocus.focus({ preventScroll: true });
}
lightbox.addEventListener('click', (e) => {
  // The image itself is excluded: it's the zoom/pan surface now (a plain
  // click there toggles zoom -- see the pointerdown handler below), not a
  // second way to close. Only the backdrop closes on click.
  if (e.target === lightbox) closeLightbox();
});
$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox-prev').addEventListener('click', () => lightboxStep(-1));
$('lightbox-next').addEventListener('click', () => lightboxStep(1));
$('lightbox-zoom-in').addEventListener('click', () => setLightboxZoom(lightboxZoom + 0.5));
$('lightbox-zoom-out').addEventListener('click', () => setLightboxZoom(lightboxZoom - 0.5));
$('lightbox-zoom-reset').addEventListener('click', () => setLightboxZoom(1));
lightbox.addEventListener('wheel', (e) => {
  e.preventDefault();
  setLightboxZoom(lightboxZoom + (e.deltaY < 0 ? 0.25 : -0.25));
}, { passive: false });
// pointerdown -> setPointerCapture -> pointermove/up/cancel, same pattern as
// the sidebar resizer -- doubles as both the drag-to-pan gesture (when
// zoomed and the pointer actually moves) and a plain click's zoom toggle
// (when it doesn't), since telling the two apart needs the same up-front
// pointerdown/movement tracking either way.
lightboxImg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const startX = e.clientX, startY = e.clientY;
  const startPanX = lightboxPanX, startPanY = lightboxPanY;
  let moved = false;
  lightboxImg.setPointerCapture(e.pointerId);
  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (!moved || lightboxZoom <= 1) return;
    lightboxImg.classList.add('dragging');
    lightboxPanX = startPanX + dx;
    lightboxPanY = startPanY + dy;
    clampLightboxPan();
    applyLightboxTransform();
  };
  const onUp = (ev) => {
    lightboxImg.releasePointerCapture(ev.pointerId);
    lightboxImg.classList.remove('dragging');
    lightboxImg.removeEventListener('pointermove', onMove);
    lightboxImg.removeEventListener('pointerup', onUp);
    lightboxImg.removeEventListener('pointercancel', onUp);
    if (!moved) setLightboxZoom(lightboxZoom > 1 ? 1 : 2);
  };
  lightboxImg.addEventListener('pointermove', onMove);
  lightboxImg.addEventListener('pointerup', onUp);
  lightboxImg.addEventListener('pointercancel', onUp);
});
// aria-modal="true" (index.html) promises a focus trap; nothing enforced one,
// so Tab could reach a real button hidden behind the opaque overlay — mirrors
// the a11y/help overlays' trap below, generalized rather than hardcoded to a
// specific control count (already handling the prev/next/zoom buttons here
// with no changes needed). Escape is already handled by the global
// Escape-priority-chain keydown listener, not duplicated here.
lightbox.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); lightboxStep(-1); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); lightboxStep(1); return; }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); setLightboxZoom(lightboxZoom + 0.5); return; }
  if (e.key === '-') { e.preventDefault(); setLightboxZoom(lightboxZoom - 0.5); return; }
  if (e.key === '0') { e.preventDefault(); setLightboxZoom(1); return; }
  if (e.key !== 'Tab') return;
  const focusables = Array.from(lightbox.querySelectorAll('a, button, select, input, [tabindex="0"]'))
    .filter((el) => el.offsetParent !== null && !el.disabled);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ---------------- footnote hover preview ---------------- */

const footpop = $('footpop');
let footpopTimer = null;
function showFootPop(refLink) {
  const href = refLink.getAttribute('href') || '';
  if (!href.startsWith('#')) return;
  const li = document.getElementById(href.slice(1));
  if (!li) return;
  footpop.innerHTML = DOMPurify.sanitize(li.innerHTML, PURIFY_CFG);
  footpop.hidden = false;
  const r = refLink.getBoundingClientRect();
  footpop.style.left = Math.min(r.left, window.innerWidth - footpop.offsetWidth - 12) + 'px';
  const below = r.bottom + 8;
  const top = below + footpop.offsetHeight > window.innerHeight
    ? r.top - footpop.offsetHeight - 8 : below;
  footpop.style.top = Math.max(6, top) + 'px';
}
function hideFootPop() {
  footpop.hidden = true;
}
content.addEventListener('mouseover', (e) => {
  const ref = e.target.closest('.footnote-ref a, sup.footnote-ref > a, a.footnote-ref');
  clearTimeout(footpopTimer);
  if (ref) footpopTimer = setTimeout(() => showFootPop(ref), 150);
  else if (!e.target.closest('#footpop')) hideFootPop();
});
content.addEventListener('focusin', (e) => {
  const ref = e.target.closest('.footnote-ref a, sup.footnote-ref > a, a.footnote-ref');
  if (ref) showFootPop(ref);
  else hideFootPop();
});
// #footpop is a sibling of #content, not a descendant (it's positioned via
// fixed coordinates next to the reference, wherever that happens to be) — so
// moving the mouse from a reference toward the popup crosses #content's
// boundary and would fire this mouseleave before the cursor ever reaches it.
// relatedTarget is where the pointer is going; let it through in that case
// and rely on footpop's own mouseleave (below) to close it once actually left.
content.addEventListener('mouseleave', (e) => {
  if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#footpop')) return;
  hideFootPop();
});
footpop.addEventListener('mouseleave', hideFootPop);

/* ================================================================ menus & panels */

const menuPop = $('menu-pop');
const btnMenu = $('btn-menu');

// Up to five other recent files, so switching documents doesn't mean going
// back to the welcome screen. Lives inside the existing menu — no new chrome.
function fillMenuRecent() {
  const wrap = $('menu-recent');
  const sep = $('menu-recent-sep');
  wrap.innerHTML = '';
  const others = S.recent.filter((r) => r.path !== doc.path).slice(0, 5);
  sep.hidden = !others.length;
  if (!others.length) return;
  const head = document.createElement('div');
  head.className = 'menu-head';
  head.textContent = 'Recent';
  wrap.appendChild(head);
  for (const r of others) {
    const btn = document.createElement('button');
    btn.setAttribute('role', 'menuitem');
    btn.dataset.path = r.path;
    btn.textContent = r.name;
    btn.title = r.path;
    wrap.appendChild(btn);
  }
}

function openMenu() {
  fillMenuRecent();
  menuPop.hidden = false;
  btnMenu.setAttribute('aria-expanded', 'true');
  const r = btnMenu.getBoundingClientRect();
  menuPop.style.top = r.bottom + 6 + 'px';
  menuPop.style.left = Math.max(8, r.right - menuPop.offsetWidth) + 'px';
  const disabled = doc.kind !== 'file';
  const noFile = disabled || doc.untitled;   // untitled has nothing on disk yet
  menuPop.querySelector('[data-act="reload"]').style.display = noFile ? 'none' : '';
  menuPop.querySelector('[data-act="reveal"]').style.display = noFile ? 'none' : '';
  menuPop.querySelector('[data-act="edit"]').style.display = disabled ? 'none' : '';
  menuPop.querySelector('[data-act="save"]').style.display = disabled || !dirty ? 'none' : '';
  menuPop.querySelector('[data-act="saveas"]').style.display = disabled ? 'none' : '';
  menuPop.querySelector('[data-act="exporthtml"]').style.display = disabled ? 'none' : '';
  menuPop.querySelector('[data-act="exportpdf"]').style.display = disabled ? 'none' : '';
  menuPop.querySelector('[data-act="copyrich"]').style.display = disabled ? 'none' : '';
  menuPop.querySelector('[data-act="edit"]').firstChild.nodeValue =
    editing ? 'Back to reading ' : 'Edit this file ';
  menuPop.querySelector('button').focus();
}
function closeMenu(refocus) {
  if (menuPop.hidden) return;
  menuPop.hidden = true;
  btnMenu.setAttribute('aria-expanded', 'false');
  if (refocus) btnMenu.focus();
}
btnMenu.addEventListener('click', () => (menuPop.hidden ? openMenu() : closeMenu(true)));
document.addEventListener('pointerdown', (e) => {
  if (!menuPop.hidden && !e.target.closest('#menu-pop') && !e.target.closest('#btn-menu')) closeMenu(false);
});
menuPop.addEventListener('keydown', (e) => {
  const items = Array.from(menuPop.querySelectorAll('button')).filter((b) => b.style.display !== 'none');
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
});
menuPop.addEventListener('click', (e) => {
  const recent = e.target.closest('button[data-path]');
  if (recent) {
    closeMenu(false);
    if (!confirmDiscard('Opening another file will discard them.')) return;
    post({ type: 'openPath', path: recent.dataset.path, nav: 'new' });
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  closeMenu(false);
  switch (btn.dataset.act) {
    case 'new': CMDS.newDoc(); break;
    case 'open': post({ type: 'openDialog' }); break;
    case 'edit': toggleEdit(); break;
    case 'save': saveDoc(false); break;
    case 'saveas': saveDoc(true); break;
    case 'reload': CMDS.reloadRequest(); break;
    case 'reveal': post({ type: 'revealDoc' }); break;
    case 'print': window.print(); break;
    case 'exporthtml': exportHtml(); break;
    case 'exportpdf': exportPdf(); break;
    case 'copyrich': copyAsRichText(); break;
    case 'demo':
      if (confirmDiscard('Opening the feature tour will discard them.')) loadDemo();
      break;
    case 'help': openPanel('help'); break;
  }
});

/* ---------------- dialogs (a11y panel, help) ---------------- */

let panelReturnFocus = null;
function openPanel(name) {
  closeMenu(false);
  const overlay = $(name + '-overlay');
  if (!overlay || !overlay.hidden) return;
  panelReturnFocus = document.activeElement;
  overlay.hidden = false;
  if (name === 'help') fillHelpDocInfo();
  const panel = overlay.querySelector('[role="dialog"]');
  const first = panel.querySelector('select, input, button');
  (first || panel).focus();
}
function closePanel(name, refocus) {
  const overlay = $(name + '-overlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  if (refocus !== false && panelReturnFocus) panelReturnFocus.focus({ preventScroll: true });
}
function anyPanelOpen() {
  return !$('a11y-overlay').hidden || !$('help-overlay').hidden;
}
for (const name of ['a11y', 'help']) {
  const overlay = $(name + '-overlay');
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) closePanel(name);
  });
  overlay.querySelector('.panel-close').addEventListener('click', () => closePanel(name));
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePanel(name); return; }
    if (e.key !== 'Tab') return;
    const focusables = Array.from(overlay.querySelectorAll('a, button, select, input, [tabindex="0"]'))
      .filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// Count what's in the document. While editing we measure the text as it stands
// right now rather than the last preview, so the numbers are never stale.
function documentStats() {
  let root = content;
  if (editing) {
    const body = splitFrontMatter(editor.value).body;
    // While editing, this renders the full document synchronously on this
    // thread just to count things in it — unlike the actual document render,
    // which offloads exactly this cost to a worker past the same threshold.
    // F1 is a deliberate, occasional action, not the live-typing word count
    // (that stays cheap — see refreshEditorViews()), so above the threshold
    // this trades a few detailed counts for not stalling the page.
    if (body.length >= PROGRESSIVE_THRESHOLD) {
      return [
        ['Words', editorWords.toLocaleString()],
        ['Reading time', Math.max(1, Math.round(editorWords / 220)) + ' min'],
        ['Note', 'large document — open in reading view for full details']
      ];
    }
    root = document.createElement('div');
    root.innerHTML = DOMPurify.sanitize(md.render(body), PURIFY_CFG);
  }
  const q = (sel) => root.querySelectorAll(sel).length;
  const words = countVisibleWords(root);
  const boxes = root.querySelectorAll('input[type="checkbox"]');
  let done = 0;
  boxes.forEach((b) => { if (b.checked) done++; });
  return [
    ['Words', words.toLocaleString()],
    ['Reading time', Math.max(1, Math.round(words / 220)) + ' min'],
    ['Headings', q('h1,h2,h3,h4,h5,h6') - q('.footnotes :is(h1,h2,h3,h4,h5,h6)')],
    ['Links', q('a[href]') - q('a.hanchor') - q('.footnote-backref')],
    ['Images', q('img')],
    ['Code blocks', q('pre')],
    ['Tables', q('table')],
    ['Tasks', boxes.length ? done + ' / ' + boxes.length : '—'],
    ['Footnotes', q('.footnotes li')],
    ['Diagrams', q('.mermaid-fig') + q('pre > code.language-mermaid')]
  ];
}

// File-level info (docs/BACKLOG.md's Features #10) -- native-authoritative
// (main.cpp's SendDocMsg), unlike documentStats()'s content-derived counts
// below: encoding/line-endings/size/modified don't change between read and
// edit mode the way word/heading/etc. counts legitimately can.
function documentFileInfo() {
  if (doc.kind !== 'file') return [];   // the feature-tour demo isn't a real file on disk
  const size = doc.size < 1024 ? doc.size + ' B' : (doc.size / 1024).toFixed(1) + ' KB';
  return [
    ['Encoding', doc.encoding || 'UTF-8'],
    ['Line endings', doc.crlf ? 'CRLF' : 'LF'],
    ['Size', size],
    ['Modified', doc.modified ? new Date(doc.modified).toLocaleString() : '—'],
  ];
}

function fillHelpDocInfo() {
  const wrap = $('help-docinfo');
  $('help-version').textContent = 'v' + (BOOT.version || '');
  if (doc.kind === 'none') { wrap.hidden = true; return; }
  $('help-docinfo-text').textContent =
    doc.name + (doc.path ? ' — ' + doc.path : ' (not saved yet)');

  const grid = $('help-docstats');
  grid.innerHTML = '';
  for (const [label, value] of [...documentFileInfo(), ...documentStats()]) {
    if (value === 0) continue;                 // don't list what isn't there
    const cell = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = String(value);
    const s = document.createElement('span');
    s.textContent = label;
    cell.append(b, s);
    grid.appendChild(cell);
  }
  wrap.hidden = false;
}

$('btn-a11y').addEventListener('click', () => openPanel('a11y'));

/* ---------------- a11y panel wiring ---------------- */

function syncA11yControls() {
  $('set-font').value = S.font;
  $('set-size').value = S.fontSize;
  $('out-size').textContent = S.fontSize + '%';
  $('set-lh').value = S.lineHeight;
  $('out-lh').textContent = Number(S.lineHeight).toFixed(2);
  $('set-ls').value = S.letterSpacing;
  $('out-ls').textContent = Number(S.letterSpacing).toFixed(2) + 'em';
  $('set-width').value = S.contentWidth;
  $('set-motion').value = S.motion;
  $('set-contrast').checked = S.highContrast;
  $('set-underline').checked = S.underlineLinks;
  $('set-dim').checked = S.dimImages;
  $('set-wrap').checked = S.codeWrap;
  $('set-spellcheck').checked = S.spellcheck;
  $('set-restore').checked = S.restoreLastDoc;
}

function bindPref(id, key, transform, outputId, fmt) {
  $(id).addEventListener('input', (e) => {
    S[key] = transform ? transform(e.target.value, e.target) : e.target.value;
    if (outputId) $(outputId).textContent = fmt(S[key]);
    applyPrefs();
    save();
  });
}
bindPref('set-font', 'font');
bindPref('set-size', 'fontSize', (v) => Number(v), 'out-size', (v) => v + '%');
bindPref('set-lh', 'lineHeight', (v) => Number(v), 'out-lh', (v) => v.toFixed(2));
bindPref('set-ls', 'letterSpacing', (v) => Number(v), 'out-ls', (v) => v.toFixed(2) + 'em');
bindPref('set-width', 'contentWidth');
bindPref('set-motion', 'motion');
bindPref('set-contrast', 'highContrast', (v, el) => el.checked);
bindPref('set-underline', 'underlineLinks', (v, el) => el.checked);
bindPref('set-dim', 'dimImages', (v, el) => el.checked);
bindPref('set-wrap', 'codeWrap', (v, el) => el.checked);
bindPref('set-spellcheck', 'spellcheck', (v, el) => el.checked);
bindPref('set-restore', 'restoreLastDoc', (v, el) => el.checked);

$('set-reset').addEventListener('click', () => {
  // Only the reading settings this panel actually shows and controls get
  // reset (per its own toast below) — theme has its own always-visible
  // topbar button, sidebarWidth is drag-resize state, and findCase/findWord/
  // findRegex belong to the separate Find feature; none of them are in this
  // dialog, so a reader wouldn't expect this button to silently change them too.
  const keep = {
    recent: S.recent, positions: S.positions, sidebar: S.sidebar,
    theme: S.theme, sidebarWidth: S.sidebarWidth,
    findCase: S.findCase, findWord: S.findWord, findRegex: S.findRegex
  };
  S = Object.assign({}, DEFAULTS, keep);
  syncA11yControls();
  applyPrefs();
  save();
  toast('Reading settings reset to defaults.');
});

/* ---------------- theme button ---------------- */

const themeOrder = ['light', 'dark', 'system'];
function updateThemeButton() {
  const t = S.theme;
  $('theme-sun').hidden = t !== 'light';
  $('theme-moon').hidden = t !== 'dark';
  $('theme-auto').hidden = t !== 'system';
  $('btn-theme').setAttribute('aria-label',
    'Theme: ' + (t === 'system' ? 'follow system' : t) + ' — click to change');
}
$('btn-theme').addEventListener('click', () => {
  S.theme = themeOrder[(themeOrder.indexOf(S.theme) + 1) % themeOrder.length];
  applyPrefs();
  save();
  toast('Theme: ' + (S.theme === 'system' ? 'follow system' : S.theme));
});

/* ================================================================ welcome & recent */

function renderRecent() {
  const wrap = $('recent-wrap');
  const list = $('recent-list');
  list.innerHTML = '';
  if (!S.recent.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  for (const r of S.recent) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'recent-open';
    open.type = 'button';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = r.name;
    const path = document.createElement('span');
    path.className = 'recent-path';
    path.textContent = r.path;
    open.append(name, path);
    open.title = r.path;
    open.addEventListener('click', () => post({ type: 'openPath', path: r.path, nav: 'new' }));
    const x = document.createElement('button');
    x.className = 'iconbtn small recent-x';
    x.type = 'button';
    x.setAttribute('aria-label', 'Remove ' + r.name + ' from recent files');
    x.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    x.addEventListener('click', () => {
      const idx = S.recent.findIndex((q) => q.path === r.path);
      S.recent = S.recent.filter((q) => q.path !== r.path);
      save();
      renderRecent();
      // renderRecent() just destroyed the button this click (or Enter/Space)
      // was on, which would otherwise silently drop focus to <body> --
      // land it on a sensible neighbor instead: the same row position's
      // remove button, the last one if this was the last row, or back to
      // "Open a file" once the list is empty.
      const xs = list.querySelectorAll('.recent-x');
      if (xs.length) xs[Math.min(idx, xs.length - 1)].focus();
      else $('btn-open').focus();
    });
    li.append(open, x);
    list.appendChild(li);
  }
}
$('btn-open').addEventListener('click', () => post({ type: 'openDialog' }));
$('btn-new').addEventListener('click', () => CMDS.newDoc());
$('btn-demo').addEventListener('click', () => loadDemo());

/* ================================================================ keyboard */

let isFullscreen = false;

document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

  // Combos owned by the native shell (it acts via the accelerator event);
  // swallow them here so nothing double-fires if the DOM also sees the key.
  const k = e.key.toLowerCase();
  if ((e.ctrlKey && !e.altKey && ['f', 'g', 'b', 'o', 'r', 's', 'j', 'l', 'n', 't', 'u', 'e', 'd', 'h', 'w', ',', '+', '-', '=', '0'].includes(k)) ||
      (!e.ctrlKey && !e.altKey && ['F1', 'F3', 'F5', 'F11'].includes(e.key)) ||
      (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) {
    e.preventDefault();
    return;
  }

  if (e.key === 'Escape') {
    if (!menuPop.hidden) { closeMenu(true); return; }
    if (!lightbox.hidden) { closeLightbox(); return; }
    if (anyPanelOpen()) { closePanel('a11y'); closePanel('help'); return; }
    if (!footpop.hidden) { hideFootPop(); return; }
    if (searchOpen) { closeFind(); return; }
    if (isFullscreen) { post({ type: 'fullscreen' }); return; }
    if (!sidebar.hidden && window.innerWidth <= 1000) { setSidebar(false); return; }
    return;
  }

  if (inField || e.ctrlKey || e.altKey || e.metaKey) return;
  if (anyPanelOpen() || !lightbox.hidden || !menuPop.hidden) return;

  if (e.key === '/') { e.preventDefault(); openFind(); }
  else if (e.key === '?') { e.preventDefault(); openPanel('help'); }
  else if (e.key === 'n') { e.preventDefault(); gotoHeading(1); }
  else if (e.key === 'p') { e.preventDefault(); gotoHeading(-1); }
  else if (e.key === 'g' && doc.kind !== 'none') {
    e.preventDefault();
    $('page-input').focus();
  }
});

/* ================================================================ editing

   A plain-text editor over the same reading column. It is deliberately not a
   rich editor: Markdown is text, and the fastest thing we can offer is the raw
   source with the renderer one keystroke away. Nothing is ever written to disk
   without an explicit Save. */

const editor = $('editor');
let editing = false;
let dirty = false;
let savedText = '';        // the text as it exists on disk
let pendingNewDoc = false; // a new document was requested; open it in the editor
let editorWords = 0;       // live word count of the source being edited
let editorRefreshTimer = null;

// A cheap approximation of "words in the rendered document" that doesn't
// require rendering: strip each line's leading block markers (blockquote
// '>', heading '#', list bullet/number) before counting whitespace-separated
// tokens, so those markers don't get counted as words of their own the way
// they would in the raw source -- documentStats()'s F1 panel counts the
// fully-rendered text instead, and the two disagreeing by ~16% on an
// ordinarily-formatted document (measured: 37 raw vs 32 rendered words for a
// heading + list + blockquote + a plain paragraph) is a real, confusing
// inconsistency between two word counts shown for the same document, not
// just estimate noise. Not exact -- inline syntax (fences, horizontal
// rules, link brackets) isn't touched -- but it closes most of the gap
// while staying cheap enough to run on every keystroke.
function countWordsInSource(text) {
  const stripped = text.split('\n')
    .map((line) => line.replace(/^\s{0,3}(?:>\s*){0,4}(?:#{1,6}(?=\s|$)|[-*+](?=\s|$)|\d{1,9}[.)](?=\s|$))?\s*/, ''))
    .join('\n');
  return (stripped.trim().match(/\S+/g) || []).length;
}

// Re-derive everything that hangs off the source text: outline, word count,
// page count. Debounced so a burst of typing costs one pass, not one per key.
function refreshEditorViews() {
  clearTimeout(editorRefreshTimer);
  editorRefreshTimer = setTimeout(() => {
    if (!editing) return;
    editorWords = countWordsInSource(editor.value);
    $('sb-pct').title = editorWords.toLocaleString() + ' words · about ' +
      Math.max(1, Math.round(editorWords / 220)) + ' min read';
    buildEditorToc();
    updateProgress();
  }, 200);
}

function setDirty(on) {
  if (dirty === on) return;
  dirty = on;
  post({ type: 'dirty', on: on ? '1' : '0' });
  updateEditUI();
}

function updateEditUI() {
  const editable = doc.kind === 'file';
  $('btn-edit').hidden = !editable;
  $('btn-edit').setAttribute('aria-pressed', String(editing));
  $('btn-edit').setAttribute('aria-label', editing ? 'Back to reading view' : 'Edit this file');
  $('btn-edit').title = editing ? 'Back to reading (Ctrl+E)' : 'Edit (Ctrl+E)';

  const state = $('sb-state');
  const label = dirty ? 'Unsaved changes' : (editing ? 'Editing' : '');
  state.hidden = !label;
  $('sb-state-text').textContent = label;
  state.classList.toggle('dirty', dirty);
  syncReplaceControls();
}

function enterEdit() {
  if (doc.kind !== 'file') { toast('Only files on disk can be edited.'); return; }
  if (editing) return;
  // Captured before anything below changes scroll/visibility -- main is
  // still the reading view's own scroll container at this point (scroller()
  // switches to the editor only once `editing` flips true, just below).
  const readHeadingIdx = currentHeadingIndex();
  closeFind();
  ensureTurndown();
  editing = true;
  post({ type: 'editing', on: '1' });
  editor.value = dirty ? editor.value : doc.source;
  savedText = dirty ? savedText : doc.source;
  content.hidden = true;
  editor.hidden = false;
  $('editor-toolbar').hidden = false;
  $('statusbar').hidden = false;
  editor.focus();
  // Land the caret at whatever section was on screen while reading, not
  // always line 1 -- sourceHeadings() finds the same headings in the same
  // order currentHeadingIndex() counted through, so its index lines up.
  // Falls back to the very start when nothing was "current" yet (scrolled
  // to the top, or a document with no headings at all).
  const srcHeadings = sourceHeadings(editor.value);
  const caretAt = readHeadingIdx >= 0 && srcHeadings[readHeadingIdx] ? srcHeadings[readHeadingIdx].index : 0;
  editor.setSelectionRange(caretAt, caretAt);
  updateEditUI();
  updateCaretPosition();
  editorWords = countWordsInSource(editor.value);
  buildEditorToc();
  updateProgress();
  say('Editing ' + doc.name + '. Press Control E to go back to reading, Control S to save.');
}

// Leaving the editor renders what's in it, so you can preview unsaved edits.
function leaveEdit() {
  if (!editing) return;
  const text = editor.value;
  editing = false;
  post({ type: 'editing', on: '0' });
  editor.hidden = true;
  $('editor-toolbar').hidden = true;
  content.hidden = false;
  updateEditUI();
  renderDocument(text, {
    kind: 'file', name: doc.name, path: doc.path, dir: doc.dir,
    plain: doc.plain ? '1' : '0', nav: 'preview',
    // A preview never touches the file on disk, so its info hasn't changed --
    // carry it through rather than letting the defaults above wipe it out.
    bom: doc.bom ? '1' : '0', crlf: doc.crlf ? '1' : '0',
    encoding: doc.encoding, size: doc.size, modified: doc.modified
  });
  say(dirty ? 'Preview of your unsaved changes.' : 'Reading view.');
}

function toggleEdit() { editing ? leaveEdit() : enterEdit(); }

function saveDoc(saveAs) {
  if (doc.kind !== 'file') { toast('This view has no file to save.'); return; }
  const text = editing ? editor.value : doc.source;
  if (!saveAs && !dirty) { toast('No changes to save.'); return; }
  post({ type: saveAs ? 'saveAsDoc' : 'saveDoc', text });
}

// Shared by "Export as HTML" and "Copy as rich text" (docs/BACKLOG.md's
// Features #2). Whatever #content currently holds -- same limitation
// "Print" already has (see app.css's @media print comment): while editing,
// that's the last-rendered PREVIEW, not necessarily today's unsaved
// keystrokes, since re-rendering on every edit would be wasteful. Mermaid
// diagrams need no extra work: they're already static <svg> in the DOM by
// the time this runs. Strips the two things that are pure interactive
// chrome with no function once the markup leaves this page: the copy
// button on each code block (nothing to copy TO without this app's own
// clipboard handler) and live task-checkbox interactivity (nothing
// persists a click in a standalone file, so it reads as disabled instead
// of falsely inviting one).
function renderableContentHtml() {
  const clone = content.cloneNode(true);
  clone.querySelectorAll('.copybtn').forEach((b) => b.remove());
  clone.querySelectorAll('input[type="checkbox"]').forEach((b) => { b.disabled = true; });
  return clone.innerHTML;
}

// A small, hand-written stylesheet -- deliberately NOT the live app's own
// theme (app.css is full of chrome-specific rules and CSS custom
// properties tied to the reading UI, not a standalone document). Math gets
// its own separate embedding step (buildKatexEmbedCss()) only when the
// document actually contains any, so a document with no math doesn't pay
// for ~300KB of embedded font data it'll never use. Everything else --
// headings, tables, code, blockquotes, images, and already-static Mermaid
// SVGs -- looks like a clean, readable article from this alone.
const EXPORT_CSS = `
body { max-width: 760px; margin: 40px auto; padding: 0 20px; font: 16px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; color: #1a1a1a; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; }
h1 { font-size: 2em; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
a { color: #0b5fff; }
img { max-width: 100%; }
code { font-family: ui-monospace, Consolas, monospace; background: #f2f2f2; padding: 0.15em 0.35em; border-radius: 4px; font-size: 0.9em; }
pre { background: #f6f8fa; padding: 12px 16px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 0; padding: 0 1em; color: #555; border-left: 4px solid #ddd; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
th { background: #f6f8fa; }
hr { border: none; border-top: 1px solid #ddd; }
.hanchor { margin-right: 6px; color: #aaa; text-decoration: none; }
`;

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;   // String.fromCharCode.apply has an argument-count limit
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// KaTeX's own CSS references its font files as relative fonts/*.woff2 urls
// -- fine for the live app (served from this app's own origin), but the
// exported HTML is a standalone file with no such origin to resolve them
// against. Only fetched at export time (not loaded on every page render)
// and only when buildStandaloneHtml() below finds real math in the
// document, since a document with none would otherwise carry ~300KB of
// embedded font data for nothing. Deliberately just the woff2 variant --
// real browsers, this app's own embedded Chromium included, have
// supported it for years, and the vendored CSS's .woff/.ttf fallback
// url()s point at files that were never actually vendored in the first
// place (assets/vendor/fonts/ has only ever shipped .woff2).
async function buildKatexEmbedCss() {
  const css = await (await fetch('vendor/katex.min.css')).text();
  const fontUrls = new Set();
  for (const m of css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)) fontUrls.add(m[1]);

  const dataUrls = new Map();
  await Promise.all(Array.from(fontUrls, async (url) => {
    const buf = await (await fetch('vendor/' + url)).arrayBuffer();
    dataUrls.set(url, 'data:font/woff2;base64,' + arrayBufferToBase64(buf));
  }));

  // Collapses each @font-face's multi-format src list down to just the one
  // embedded woff2 data URI.
  return css.replace(
    /src:url\(fonts\/[^)]+\.woff2\) format\("woff2"\)(?:,url\([^)]+\) format\("[^"]+"\))*/g,
    (fullMatch) => {
      const url = fullMatch.match(/url\((fonts\/[^)]+\.woff2)\)/)[1];
      return 'src:url(' + dataUrls.get(url) + ') format("woff2")';
    },
  );
}

async function buildStandaloneHtml() {
  const title = doc.name || 'Document';
  const bodyHtml = renderableContentHtml();
  const katexCss = content.querySelector('.katex') ? await buildKatexEmbedCss() : '';
  return '<!doctype html>\n<html><head><meta charset="utf-8"><title>' +
    title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) +
    '</title><style>' + EXPORT_CSS + katexCss + '</style></head><body>' +
    bodyHtml + '</body></html>';
}

async function exportHtml() {
  if (doc.kind !== 'file') { toast('There is no document to export.'); return; }
  post({ type: 'exportHtml', html: await buildStandaloneHtml() });
}

// Unlike exportHtml(), there's no page-built payload to send -- native's own
// WebView2 PrintToPdf() renders whatever the page currently shows, the exact
// same mechanism Ctrl+P already reaches via the OS print dialog, so this
// gets the same @media print rules (app.css) for free: chrome hidden,
// #content forced visible even while editing.
function exportPdf() {
  if (doc.kind !== 'file') { toast('There is no document to export.'); return; }
  post({ type: 'exportPdf' });
}

async function copyAsRichText() {
  if (doc.kind !== 'file') { toast('There is no document to copy.'); return; }
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
    toast('Rich-text copy is not supported in this environment.');
    return;
  }
  try {
    const html = renderableContentHtml();
    const text = content.innerText;
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
    toast('Copied as rich text — paste into a word processor or email.');
  } catch (e) {
    toast('Could not copy: ' + e.message);
  }
}

// True when it is safe to throw away what's on screen.
function confirmDiscard(action) {
  if (!dirty) return true;
  return window.confirm('You have unsaved changes to ' + doc.name + '.\n\n' + action);
}

editor.addEventListener('input', () => {
  setDirty(editor.value !== savedText);
  refreshEditorViews();
  // Keep an open search honest as the text changes underneath it.
  if (searchOpen && lastQuery) {
    matches = collectMatches(lastQuery, findOpts());
    matchIdx = matches.length ? Math.min(Math.max(matchIdx, 0), matches.length - 1) : -1;
    findCount.textContent = matches.length
      ? (matchIdx + 1) + ' / ' + matches.length : 'No results';
  }
});

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Never trap keyboard users inside the text area.
    e.preventDefault();
    e.stopPropagation();
    main.focus({ preventScroll: true });
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    if (!tableTab(e.shiftKey)) indentSelection(e.shiftKey);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && continueBlock()) {
    e.preventDefault();
    return;
  }
  if (e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); wrapSelection('**', '**', 'bold text'); }
    else if (k === 'i') { e.preventDefault(); wrapSelection('*', '*', 'italic text'); }
    else if (k === 'k') { e.preventDefault(); wrapSelection('[', '](url)', 'link text'); }
    else if (k === '`') { e.preventDefault(); wrapSelection('`', '`', 'code'); }
  }
});

// Every programmatic edit goes through insertText rather than setRangeText, so
// each one lands on the browser's own undo stack and Ctrl+Z behaves normally.
function replaceRange(start, end, text, selStart, selEnd) {
  const previous = document.activeElement;
  if (previous !== editor) editor.focus();
  editor.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
  if (!ok) editor.setRangeText(text, start, end, 'preserve');   // last resort; loses undo
  if (selStart != null) editor.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
  if (previous && previous !== editor && typeof previous.focus === 'function') previous.focus();
  setDirty(editor.value !== savedText);
}

function wrapSelection(before, after, placeholder) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const sel = editor.value.slice(s, e) || placeholder;
  replaceRange(s, e, before + sel + after, s + before.length, s + before.length + sel.length);
}

/* ---------------- toolbar formatting (write mode) ----------------
   Block-level actions (list/quote/heading/table/code-fence) for the editor
   toolbar. Unlike continueBlock()'s Enter-key list carrying, these always
   *add* their construct rather than toggling it off if already present —
   consistent with wrapSelection()'s existing bold/italic/link buttons,
   which behave the same way (clicking Bold on already-bold text adds more
   asterisks, it doesn't remove the existing ones). */

// Prefix every line the selection touches (or just the current line, for a
// collapsed selection) with `prefix` — or, for a numbered list, an
// auto-incrementing "N. ".
function prefixLines(prefix) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const value = editor.value;
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  // A non-empty selection that ends exactly at the start of a line (e.g. a
  // Shift+Down that highlighted the previous line's content plus its
  // trailing newline, but none of the next line's own characters) never
  // actually touched that next line — search from just before the boundary
  // instead of past it, so that line isn't pulled in and prefixed too.
  const searchFrom = (e > s && e > 0 && value[e - 1] === '\n') ? e - 1 : e;
  const lineEnd = value.indexOf('\n', searchFrom) === -1 ? value.length : value.indexOf('\n', searchFrom);
  const block = value.slice(lineStart, lineEnd);
  let n = 1;
  const shifted = block.split('\n').map((line) => (prefix === null ? (n++ + '. ') : prefix) + line).join('\n');
  replaceRange(lineStart, lineEnd, shifted, lineStart, lineStart + shifted.length);
}

// Cycles the current line through paragraph -> H1 -> H2 -> ... -> H6 ->
// paragraph, reading the line's *current* level fresh on every call rather
// than tracking separate UI state — so it's always correct regardless of
// which line the caret was last on, with no way for a cached level to get
// out of sync with what's actually on the line.
function cycleHeadingLevel() {
  const s = editor.selectionStart;
  const value = editor.value;
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const lineEnd = value.indexOf('\n', s) === -1 ? value.length : value.indexOf('\n', s);
  const line = value.slice(lineStart, lineEnd);
  const m = line.match(/^\s{0,3}(#{1,6})\s+/);
  const next = (m ? m[1].length : 0) >= 6 ? 0 : (m ? m[1].length : 0) + 1;
  const stripped = line.replace(/^\s{0,3}#{1,6}\s+/, '');
  const newLine = (next > 0 ? '#'.repeat(next) + ' ' : '') + stripped;
  replaceRange(lineStart, lineEnd, newLine, s + (newLine.length - line.length));
  return next > 0 ? 'Heading ' + next : 'Paragraph';
}

// Shared shape behind the code/math/mermaid block buttons — a fence, an
// optional language tag, the selection (or a placeholder), a closing fence.
function insertFencedBlock(lang, placeholder) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const sel = editor.value.slice(s, e) || placeholder;
  // A selection that already contains a run of backticks as long as a plain
  // 3-backtick fence would prematurely close it — CommonMark itself requires
  // a closing fence be at least as long as its opener, so growing this one
  // past the longest run actually in the content avoids that collision.
  const longestRun = (sel.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const prefix = fence + lang + '\n';
  const wrapped = prefix + sel + '\n' + fence;
  replaceRange(s, e, wrapped, s + prefix.length, s + prefix.length + sel.length);
}

// Footnotes are two-part (a [^N] reference wherever the caret is, a
// [^N]: definition elsewhere — conventionally the document's end) and the
// two spots aren't contiguous, so this is two separate replaceRange calls
// rather than one. Numbers are picked by scanning for the highest existing
// [^N] reference and using the next one, so repeated clicks (or a document
// that already has manually-added footnotes) never collide.
function insertFootnote() {
  const used = [...editor.value.matchAll(/\[\^(\d+)\]/g)].map((m) => parseInt(m[1], 10));
  const n = (used.length ? Math.max(...used) : 0) + 1;
  const s = editor.selectionStart, e = editor.selectionEnd;
  const ref = '[^' + n + ']';
  replaceRange(s, e, ref, s + ref.length);
  const cur = editor.value;
  const endPos = cur.length;
  // Exactly one blank line before the definition, however many (or few)
  // trailing newlines the document already happens to end with.
  const trailingNl = cur.match(/\n*$/)[0].length;
  const def = '\n'.repeat(Math.max(0, 2 - trailingNl)) + '[^' + n + ']: ';
  replaceRange(endPos, endPos, def, endPos + def.length);
  return 'Footnote ' + n;
}

function insertAtCaret(text, selStart, selEnd) {
  // Both ends of the current selection, not just selectionStart: a
  // zero-width replace at start alone would leave any actually-selected
  // text in place, right after the newly-inserted template, instead of
  // being consumed by it — inconsistent with every wrapSelection()-based
  // action, which does consume the selection.
  const s = editor.selectionStart, e = editor.selectionEnd;
  replaceRange(s, e, text, s + selStart, s + (selEnd == null ? selStart : selEnd));
}

const TOOLBAR_ACTIONS = {
  heading: cycleHeadingLevel,
  bold: () => wrapSelection('**', '**', 'bold text'),
  italic: () => wrapSelection('*', '*', 'italic text'),
  strike: () => wrapSelection('~~', '~~', 'strikethrough text'),
  code: () => wrapSelection('`', '`', 'code'),
  ul: () => prefixLines('- '),
  ol: () => prefixLines(null),
  task: () => prefixLines('- [ ] '),
  quote: () => prefixLines('> '),
  link: () => wrapSelection('[', '](url)', 'link text'),
  image: () => wrapSelection('![', '](url)', 'alt text'),
  table: () => {
    const tpl = '\n| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |\n';
    const cell = tpl.indexOf('Cell');   // select the first placeholder cell, not just place the caret
    insertAtCaret(tpl, cell, cell + 4);
  },
  codeblock: () => insertFencedBlock('', 'code'),
  hr: () => insertAtCaret('\n\n---\n\n', 7),
  sub: () => wrapSelection('~', '~', 'subscript'),
  sup: () => wrapSelection('^', '^', 'superscript'),
  math: () => wrapSelection('$', '$', 'x^2'),
  mathblock: () => insertFencedBlock('math', 'x^2 + y^2 = z^2'),
  mermaid: () => insertFencedBlock('mermaid', 'graph TD\n  A[Start] --> B[End]'),
  footnote: insertFootnote,
  deflist: () => insertAtCaret('Term\n: Definition\n', 0, 4),
  // Unlike a footnote, an abbreviation definition isn't tied to a reference
  // at the caret — *[abbr]: expansion applies to every occurrence of "abbr"
  // anywhere in the document, so this is a single insertion, not two-part.
  abbr: () => {
    const tpl = '*[abbr]: Full expansion\n';
    const idx = tpl.indexOf('abbr');
    insertAtCaret(tpl, idx, idx + 4);
  },
  mark: () => wrapSelection('==', '==', 'highlighted text'),
  ins: () => wrapSelection('++', '++', 'inserted text'),
  // A full searchable picker is a much bigger UI component than anything
  // else in this toolbar (its own popup, grid, keyboard nav); an editable
  // placeholder — select the shortcode name so typing replaces it — matches
  // how Image/Abbreviation already work instead of introducing a new pattern.
  emoji: () => insertAtCaret(':smile:', 1, 6)
};
$('editor-toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-fmt]');
  if (!btn) return;
  const action = TOOLBAR_ACTIONS[btn.dataset.fmt];
  if (!action) return;
  // Most actions just confirm via their own button label ("Bold applied.");
  // cycleHeadingLevel() returns the specific level it landed on instead,
  // since "Heading applied" wouldn't tell a screen reader user which one.
  const result = action();
  say((typeof result === 'string' ? result : btn.getAttribute('aria-label')) + ' applied.');
});

// WAI-ARIA toolbar pattern: one Tab stop for the whole toolbar (only one
// button is ever tabIndex=0), arrow keys move focus within it — the 25
// buttons here would otherwise be 25 separate Tab stops between the
// document title and the text area, every single time.
(function setupToolbarRovingTabindex() {
  const toolbar = $('editor-toolbar');
  const buttons = () => Array.from(toolbar.querySelectorAll('button[data-fmt]'));
  buttons().forEach((b, i) => { b.tabIndex = i === 0 ? 0 : -1; });
  const focusIndex = (btns, i) => {
    btns.forEach((b) => { b.tabIndex = -1; });
    btns[i].tabIndex = 0;
    btns[i].focus();
  };
  toolbar.addEventListener('keydown', (e) => {
    const btns = buttons();
    const i = btns.indexOf(document.activeElement);
    if (i === -1) return;
    let next;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % btns.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + btns.length) % btns.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = btns.length - 1;
    else return;
    e.preventDefault();
    focusIndex(btns, next);
  });
  // A mouse click also moves the roving tab stop, so Tab-ing back into the
  // toolbar later resumes from whatever was last used, not always button 0.
  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fmt]');
    if (btn) focusIndex(buttons(), buttons().indexOf(btn));
  });
})();

// Pressing Enter inside a list, task list or quote carries the marker to the
// next line — and pressing it again on an empty item ends the block, the way
// every Markdown editor behaves. Returns true when it handled the key.
function continueBlock() {
  const s = editor.selectionStart;
  if (s !== editor.selectionEnd) return false;
  const v = editor.value;
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = v.indexOf('\n', s);
  if (lineEnd === -1) lineEnd = v.length;
  const line = v.slice(lineStart, s);
  // Text still ahead of the caret on this line — needed so "empty item"
  // reflects the whole item, not just the part before the caret. Without
  // this, pressing Enter right after a marker but before real content (e.g.
  // the caret in "- |hello") reads as an empty item and deletes the marker
  // instead of splitting the line, silently mangling it.
  const after = v.slice(s, lineEnd);

  const list = line.match(/^(\s*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/);
  if (list) {
    const [, indent, bullet, num, delim, gap, task, rest] = list;
    if (!rest.trim() && !after.trim()) {
      // An empty item means "I'm done with this list".
      replaceRange(lineStart, s, '', lineStart);
      return true;
    }
    const marker = bullet || (String(parseInt(num, 10) + 1) + delim);
    const insert = '\n' + indent + marker + gap + (task ? '[ ] ' : '');
    replaceRange(s, s, insert, s + insert.length);
    // Inserting mid-list leaves the items below with stale numbers.
    if (num) renumberOrderedList(s + insert.length);
    return true;
  }

  const quote = line.match(/^(\s*>[ \t]?)(.*)$/);
  if (quote) {
    if (!quote[2].trim() && !after.trim()) { replaceRange(lineStart, s, '', lineStart); return true; }
    const insert = '\n' + quote[1];
    replaceRange(s, s, insert, s + insert.length);
    return true;
  }
  return false;
}

/* ---------------- pipe tables ----------------
   Hand-writing Markdown tables is the most tedious thing the format asks of
   you, so Tab walks the cells and tidies the columns as it goes. */

// Split a row on unescaped pipes, dropping the optional leading/trailing ones.
function splitTableRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (t[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isTableLine = (line) => line != null && /^\s*\|.*\|?\s*$/.test(line) && line.includes('|');
const isDelimiterRow = (line) => {
  if (!isTableLine(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
};

// The contiguous table containing a line, or null. A table needs a header row
// followed by a delimiter row to be one.
function tableBlockAt(lineIdx, lines) {
  if (!isTableLine(lines[lineIdx])) return null;
  let start = lineIdx;
  while (start - 1 >= 0 && isTableLine(lines[start - 1])) start--;
  let end = lineIdx;
  while (end + 1 < lines.length && isTableLine(lines[end + 1])) end++;
  if (end - start < 1 || !isDelimiterRow(lines[start + 1])) return null;
  return { start, end };
}

// Rebuild a table with even columns. Widths are counted in characters, so
// full-width CJK text still lines up in the source but may look uneven in a
// proportional font — the rendered table is unaffected either way.
function formatTableLines(lines) {
  const rows = lines.map(splitTableRow);
  const aligns = rows[1].map((c) => {
    const left = c.startsWith(':'), right = c.endsWith(':');
    return left && right ? 'c' : right ? 'r' : left ? 'l' : '';
  });
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = [];
  for (let c = 0; c < cols; c++) {
    let w = 3;
    rows.forEach((r, i) => { if (i !== 1) w = Math.max(w, (r[c] || '').length); });
    widths.push(w);
  }
  const pad = (s, w, a) => {
    const gap = w - s.length;
    if (gap <= 0) return s;
    if (a === 'r') return ' '.repeat(gap) + s;
    if (a === 'c') { const l = Math.floor(gap / 2); return ' '.repeat(l) + s + ' '.repeat(gap - l); }
    return s + ' '.repeat(gap);
  };
  return { widths, lines: rows.map((cells, i) => {
    if (i === 1) {
      return '| ' + widths.map((w, c) => {
        const a = aligns[c];
        if (a === 'c') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
        if (a === 'r') return '-'.repeat(Math.max(1, w - 1)) + ':';
        if (a === 'l') return ':' + '-'.repeat(Math.max(1, w - 1));
        return '-'.repeat(w);
      }).join(' | ') + ' |';
    }
    return '| ' + widths.map((w, c) => pad(cells[c] || '', w, aligns[c])).join(' | ') + ' |';
  }) };
}

// Tab inside a table: tidy it, then move to the next cell (creating a row at
// the end). Returns true when it handled the key.
function tableTab(back) {
  const value = editor.value;
  const caret = editor.selectionStart;
  const lines = value.split('\n');
  const starts = [];
  let acc = 0;
  for (const ln of lines) { starts.push(acc); acc += ln.length + 1; }
  let li = 0;
  for (let i = 0; i < lines.length; i++) { if (starts[i] <= caret) li = i; else break; }

  const block = tableBlockAt(li, lines);
  if (!block) return false;

  // Which cell is the caret in?
  const col = (() => {
    const before = lines[li].slice(0, caret - starts[li]);
    let n = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] === '\\') { i++; continue; }
      if (before[i] === '|') n++;
    }
    return Math.max(0, n - 1);
  })();

  const body = lines.slice(block.start, block.end + 1);
  let row = li - block.start;
  const colCount = Math.max(...body.map((l) => splitTableRow(l).length));

  // Step, skipping the delimiter row, and add a row past the end.
  let nextRow = row, nextCol = col + (back ? -1 : 1);
  if (nextCol >= colCount) { nextCol = 0; nextRow++; }
  if (nextCol < 0) { nextCol = colCount - 1; nextRow--; }
  if (nextRow === 1) nextRow += back ? -1 : 1;
  if (nextRow < 0) { nextRow = 0; nextCol = 0; }
  if (nextRow >= body.length) {
    body.push('|' + ' |'.repeat(colCount));
    nextRow = body.length - 1;
    nextCol = 0;
  }

  const formatted = formatTableLines(body);
  const newBlock = formatted.lines.join('\n');
  const oldBlock = lines.slice(block.start, block.end + 1).join('\n');

  // Locate the target cell in the formatted line. Scanning for the pipes is the
  // only reliable way, since alignment padding sits inside the cell.
  let offset = 0;
  for (let i = 0; i < nextRow; i++) offset += formatted.lines[i].length + 1;
  const span = tableCellSpan(formatted.lines[nextRow], nextCol);
  const base = starts[block.start] + offset;

  replaceRange(starts[block.start], starts[block.start] + oldBlock.length, newBlock,
    base + span[0], base + span[1]);
  return true;
}

// Start and end of a cell's trimmed content within a formatted row.
function tableCellSpan(line, col) {
  const pipes = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '|') pipes.push(i);
  }
  if (col + 1 >= pipes.length) return [line.length, line.length];
  const from = pipes[col] + 1, to = pipes[col + 1];
  const raw = line.slice(from, to);
  const lead = raw.length - raw.replace(/^\s+/, '').length;
  return [from + lead, from + lead + raw.trim().length];
}

// After inserting an item into the middle of a numbered list, renumber the rest
// of that list so the source reads 1,2,3 instead of 1,2,3,3,4. Only the items
// at the caret's own indent are touched; nested lists keep their own numbering.
function renumberOrderedList(caret) {
  const lines = editor.value.split('\n');
  const starts = [];
  let acc = 0;
  for (const ln of lines) { starts.push(acc); acc += ln.length + 1; }

  let li = 0;
  for (let i = 0; i < lines.length; i++) { if (starts[i] <= caret) li = i; else break; }

  const here = lines[li].match(/^(\s*)(\d+)([.)])(\s+)/);
  if (!here) return;
  const indent = here[1];

  const asItem = (line) => {
    const m = line && line.match(/^(\s*)(\d+)([.)])(\s+)/);
    return m && m[1] === indent ? m : null;
  };
  // A deeper-indented or blank line continues the current item rather than
  // ending the list.
  const continues = (line) =>
    line != null && (asItem(line) || (line.trim() !== '' && line.startsWith(indent + ' ')) ||
      (line.trim() === ''));

  let start = li, end = li;
  while (start - 1 >= 0 && continues(lines[start - 1]) &&
         (asItem(lines[start - 1]) || lines[start - 1].trim() !== '' || asItem(lines[start - 2]))) start--;
  while (end + 1 < lines.length && continues(lines[end + 1]) &&
         (asItem(lines[end + 1]) || lines[end + 1].trim() !== '' || asItem(lines[end + 2]))) end++;
  while (start < li && !asItem(lines[start])) start++;
  while (end > li && !asItem(lines[end])) end--;

  const updated = lines.slice();
  let counter = null;
  for (let i = start; i <= end; i++) {
    const m = asItem(lines[i]);
    if (!m) continue;
    if (counter === null) counter = parseInt(m[2], 10);
    updated[i] = indent + counter + m[3] + m[4] + lines[i].slice(m[0].length);
    counter++;
  }

  const oldBlock = lines.slice(start, end + 1).join('\n');
  const newBlock = updated.slice(start, end + 1).join('\n');
  if (oldBlock === newBlock) return;

  // Keep the caret where the reader left it, allowing for wider numbers.
  let delta = 0;
  for (let i = start; i < li; i++) delta += updated[i].length - lines[i].length;
  delta += updated[li].length - lines[li].length;
  const blockStart = starts[start];
  const newCaret = Math.max(blockStart, Math.min(caret + delta, blockStart + newBlock.length));
  replaceRange(blockStart, blockStart + oldBlock.length, newBlock, newCaret);
}

/* ---------------- pasting ----------------
   Copying from a browser or a word processor puts HTML on the clipboard.
   Converting it to Markdown is almost always what you want in a Markdown
   editor; Ctrl+Shift+V pastes the raw text instead. */

// Turndown is only needed once someone is actually in the editor, so it isn't
// part of every launch's initial script load — enterEdit() kicks this off in
// the background (same lazy pattern as ensureMermaid()), well before a paste
// can plausibly happen (focus, have something on the clipboard, press
// Ctrl+V). If a paste somehow beats it, htmlToMarkdown's own
// window.TurndownService check below falls back to a plain-text paste —
// already the existing, correct behavior for "Turndown isn't available."
let turndownLoading = null;
function ensureTurndown() {
  if (window.TurndownService) return Promise.resolve();
  if (!turndownLoading) {
    turndownLoading = new Promise((resolve) => {
      const gfm = document.createElement('script');
      gfm.src = 'vendor/turndown-plugin-gfm.js';
      gfm.onload = resolve;
      gfm.onerror = resolve;   // htmlToMarkdown works without the GFM plugin too
      const core = document.createElement('script');
      core.src = 'vendor/turndown.min.js';
      core.onload = () => document.head.appendChild(gfm);
      core.onerror = resolve;
      document.head.appendChild(core);
    });
  }
  return turndownLoading;
}

let turndown = null;
function htmlToMarkdown(html) {
  if (!window.TurndownService) return null;
  if (!turndown) {
    turndown = new window.TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined'
    });
    if (window.turndownPluginGfm && window.turndownPluginGfm.gfm)
      turndown.use(window.turndownPluginGfm.gfm);
  }
  // The clipboard is untrusted input; strip anything active before parsing.
  const clean = DOMPurify.sanitize(html, PURIFY_CFG);
  try {
    return turndown.turndown(clean)
      .replace(/\n{3,}/g, '\n\n')
      // Turndown pads list markers out to four columns; match the single space
      // the rest of the editor writes.
      .replace(/^(\s*)([-*+])[ \t]{2,}/gm, '$1$2 ')
      .replace(/^(\s*)(\d+[.)])[ \t]{2,}/gm, '$1$2 ')
      .trim();
  } catch (e) { return null; }
}

// A paste event carries no modifier state, so remember the keystroke that
// triggered it.
let plainPasteUntil = 0;
editor.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') plainPasteUntil = Date.now() + 1000;
}, true);

editor.addEventListener('paste', (e) => {
  const data = (e.clipboardData || window.clipboardData);
  if (!data) return;

  // A screenshot or a copied image has no file path at all — it's raw pixel
  // data — so data.getData('text')/('text/html') both come back empty for
  // it and, without this, pasting one just silently does nothing. Read the
  // bytes and hand them to native to save as a new file next to the
  // document; native replies with the same insertImage message a dropped
  // file does, so there's nothing further to special-case here.
  const imgItem = Array.from(data.items || []).find((it) => it.type && it.type.startsWith('image/'));
  if (imgItem) {
    const file = imgItem.getAsFile();
    if (file) {
      e.preventDefault();
      const ext = imgItem.type.split('/')[1] || 'png';
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = String(reader.result).split(',')[1] || '';
        post({ type: 'saveClipboardImage', data: base64, ext });
      };
      reader.readAsDataURL(file);
      return;
    }
  }

  const text = (data.getData('text') || '');
  const s = editor.selectionStart, en = editor.selectionEnd;

  // A bare URL dropped over selected text becomes a link.
  const url = text.trim();
  if (s !== en && /^(https?:\/\/|mailto:)\S+$/i.test(url) && !/\s/.test(url)) {
    e.preventDefault();
    const sel = editor.value.slice(s, en);
    const linked = '[' + sel + '](' + url + ')';
    replaceRange(s, en, linked, s + linked.length);
    toast('Pasted as a link.');
    return;
  }

  if (Date.now() < plainPasteUntil) { plainPasteUntil = 0; return; }   // Ctrl+Shift+V

  const html = data.getData('text/html');
  if (!html || !html.trim()) return;
  const md = htmlToMarkdown(html);
  if (!md || md === text.trim()) return;   // nothing gained; let the plain text through
  e.preventDefault();
  replaceRange(s, en, md, s + md.length);
  toast('Pasted as Markdown — Ctrl+Shift+V pastes plain text.');
});

// While editing, the status bar shows the caret position instead of the
// rendered document's section — same slot, no extra chrome.
function updateCaretPosition() {
  if (!editing) return;
  const s = editor.value, caret = editor.selectionStart;
  // A single bounded scan, rather than slicing a copy of everything up to
  // the caret and splitting *that* into an array of every line in it: this
  // runs on every keystroke (keyup/click/input/select, deliberately not
  // debounced — the status bar should track the caret exactly), and for a
  // caret near the end of a large document, allocating both a full
  // substring and a line array just to report "Line N, Column N" adds up.
  let line = 1, lastNewline = -1;
  for (let i = 0; i < caret; i++) {
    if (s.charCodeAt(i) === 10) { line++; lastNewline = i; }
  }
  const col = caret - lastNewline;
  $('sb-section-text').textContent = 'Line ' + line + ', Column ' + col;
  $('sb-section').hidden = false;
  highlightEditorHeading();
}

// The text area is its own scroll container, so it drives progress while editing.
editor.addEventListener('scroll', () => {
  if (!scrollRaf) {
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateProgress(); });
  }
});
for (const evt of ['keyup', 'click', 'input', 'select']) {
  editor.addEventListener(evt, updateCaretPosition);
}

function indentSelection(outdent) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const value = editor.value;
  if (s === e && !outdent) { replaceRange(s, e, '  ', s + 2); return; }
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const lineEnd = value.indexOf('\n', e) === -1 ? value.length : value.indexOf('\n', e);
  const block = value.slice(lineStart, lineEnd);
  const shifted = block.split('\n').map((line) =>
    outdent ? line.replace(/^ {1,2}/, '') : '  ' + line).join('\n');
  replaceRange(lineStart, lineEnd, shifted, lineStart, lineStart + shifted.length);
}

$('btn-edit').addEventListener('click', toggleEdit);

/* ================================================================ navigation controls */

$('btn-back').addEventListener('click', () => navGo(-1));
$('btn-fwd').addEventListener('click', () => navGo(1));

// Page stepping is continuous reading, not a jump, so it doesn't push history.
$('page-prev').addEventListener('click', () => goToPage(pageCurrent - 1, false));
$('page-next').addEventListener('click', () => goToPage(pageCurrent + 1, false));
$('sb-section').addEventListener('click', () => setSidebar(true, true));

const pageInput = $('page-input');
pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('blur', () => updatePageUI());
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const n = parseInt(pageInput.value, 10);
    if (!isNaN(n)) goToPage(n, true);   // a typed page number *is* a jump
    else updatePageUI();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    updatePageUI();
    main.focus({ preventScroll: true });
  }
});

/* ================================================================ native messages */

const CMDS = {
  find: openFind,
  findNext: () => { if (!searchOpen) openFind(); else findStep(1); },
  findPrev: () => { if (!searchOpen) openFind(); else findStep(-1); },
  toc: () => setSidebar(sidebar.hidden, sidebar.hidden),
  a11y: () => (!$('a11y-overlay').hidden ? closePanel('a11y') : openPanel('a11y')),
  help: () => (!$('help-overlay').hidden ? closePanel('help') : openPanel('help')),
  back: () => navGo(-1),
  forward: () => navGo(1),
  toggleEdit: toggleEdit,
  save: () => saveDoc(false),
  saveAs: () => saveDoc(true),
  saveThenClose: () => post({ type: 'saveDoc', text: editing ? editor.value : doc.source }),
  reloadRequest: () => {
    if (confirmDiscard('Reloading will discard them and show the file as it is on disk.'))
      post({ type: 'reload' });
  },
  openRequest: () => {
    if (confirmDiscard('Opening another file will discard them.'))
      post({ type: 'openDialog' });
  },
  newDoc: () => {
    if (!confirmDiscard('Starting a new document will discard them.')) return;
    pendingNewDoc = true;          // drop straight into the editor once it loads
    post({ type: 'newDoc' });
  }
};

let lastZoomShown = BOOT.zoom || 100;
if (bridge) bridge.addEventListener('message', (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case 'doc':
      fetchAndRenderFile(msg);
      break;
    case 'nodoc':
      showWelcome();
      break;
    case 'cmd':
      if (CMDS[msg.cmd]) CMDS[msg.cmd]();
      break;
    case 'toast':
      toast(msg.text);
      break;
    case 'zoom': {
      const v = Number(msg.v);
      if (v !== lastZoomShown) {
        lastZoomShown = v;
        toast('Zoom ' + v + '%');
      }
      break;
    }
    case 'fs':
      isFullscreen = msg.on === '1';
      // True zen mode: fullscreen already hides the OS window chrome, this
      // hides this app's OWN chrome too (topbar, status bar) -- a CSS data
      // attribute rather than toggling .hidden directly, since #statusbar's
      // visibility is already independently managed elsewhere (no document
      // open, etc.); this only visually suppresses on top of whatever that
      // state already is, and cleanly stops doing so on exit, with nothing
      // to restore or fight over.
      document.documentElement.dataset.zen = isFullscreen ? '1' : '0';
      if (isFullscreen) toast('Full screen — press F11 or Esc to exit');
      break;
    case 'insertImage': {
      // Native only ever sends this while editing (see WM_DROPFILES), but
      // check anyway rather than trust that invariant blindly across a
      // message-passing boundary.
      if (!editing) break;
      // <...> around the destination: a bare one can't contain a space at
      // all per CommonMark, and an unbalanced ")" (common in real filenames,
      // e.g. "IMG (2).jpg") would end the link early — both are ordinary in
      // a real file path, so always wrap rather than only when "needed".
      const tpl = '![alt text](<' + msg.path + '>)';
      const altStart = tpl.indexOf('alt text');
      insertAtCaret(tpl, altStart, altStart + 'alt text'.length);
      if (msg.created) {
        // A pasted image (unlike a dropped file, which only references
        // something that already existed) just wrote a new file to disk —
        // this app's own promise is that nothing is written without being
        // asked, and an aria-live-only announcement isn't visible enough
        // for a sighted user to notice a file appeared in their folder.
        toast('Saved as ' + msg.path + ' in this file’s folder.');
      } else {
        say('Image inserted.');
      }
      break;
    }
    case 'openFailed':
      S.recent = S.recent.filter((r) => r.path !== msg.path);
      save();
      renderRecent();
      if (pendingHistRevertIdx != null) {
        // The history entry we optimistically moved to was never actually
        // reached — put idx back so Back/Forward and the button states stay
        // truthful, and drop the scroll target queued for that entry so it
        // can't get misapplied to whatever history load succeeds next.
        navHist.idx = pendingHistRevertIdx;
        pendingHistRevertIdx = null;
        pendingHistScroll = null;
        updateNavButtons();
      }
      break;
    case 'saved':
      savedText = editing ? editor.value : doc.source;
      doc.source = savedText;
      setDirty(false);
      updateEditUI();
      toast('Saved.');
      break;
    case 'saveFailed':
      updateEditUI();
      break;
  }
});

/* ================================================================ init */

applyPrefs();
syncA11yControls();
updateThemeButton();
renderRecent();
applySidebarWidth(S.sidebarWidth);
applySidebar(false);
updateNavButtons();
updateEditUI();
$('find-case').setAttribute('aria-pressed', String(S.findCase));
$('find-word').setAttribute('aria-pressed', String(S.findWord));
$('find-regex').setAttribute('aria-pressed', String(S.findRegex));

window.addEventListener('resize', () => {
  backdrop.hidden = sidebar.hidden || window.innerWidth > 1000;
  $('sidebar-resizer').hidden = sidebar.hidden || window.innerWidth <= 1000;
  updateProgress();   // page count depends on viewport height
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') save(true);
});

// Test surface for the Playwright fast harness (tools/dev, tests/harness) --
// gated on a BOOT flag native never sets in a shipping build (BOOT comes
// from window.__MDV_BOOT, only ever injected by main.cpp or a test's own
// page.addInitScript()), so this object is never constructed outside a
// harness run. app.js is one function scope, so every internal below is
// reachable here without restructuring a single line of the application
// itself -- see docs/BACKLOG.md's "tooling foundation" entry for why.
if (BOOT.testHooks) {
  window.__MDV_TEST = {
    md, decorate, TOOLBAR_ACTIONS, CMDS,
    runSearch, findStep, clearSearch,
    enterEdit, leaveEdit, saveDoc, confirmDiscard,
    setSidebar, applySidebarWidth, renderRecent, renderDocument, toast,
    htmlToMarkdown, windowsPathFrom, toDocUrl, sourceHeadings,
    rememberPosition, exportHtml, exportPdf, copyAsRichText, renderableContentHtml,
    els: { editor, content, toastEl, resizer, welcome, main, announce },
    get state() {
      return { S, DEFAULTS, doc, dirty, editing, matches, matchIdx, headings, pendingNewDoc, lastZoomShown };
    },
    setDirty: (v) => { dirty = v; },
    setEditing: (v) => { editing = v; },
    setPositions: (v) => { S.positions = v; },
    refreshEditorViews, showDiagramError, renderMermaids, openLightbox, closeLightbox,
    setRecent: (v) => { S.recent = v; },
    // Replaces S wholesale with DEFAULTS merged with `patch` -- mirrors how
    // debugRunEditorTest() used to set up a synthetic non-default S before
    // exercising #set-reset/syncA11yControls, before those checks moved out
    // to tests/specs/*.spec.mjs.
    replaceS: (patch) => { S = Object.assign({}, DEFAULTS, patch); },
    applyPrefs, openPanel, syncA11yControls,
    continueBlock, tableTab, replaceCurrent, collectMatches, findOpts,
    setLastQuery: (v) => { lastQuery = v; },
    setLastZoomShown: (v) => { lastZoomShown = v; },
    ensureTurndown, PURIFY_CFG, PURIFY_CFG_FRAGMENT,
  };
}

// Session restore (docs/BACKLOG.md's Features section): reopen the last
// document when launched with nothing to show. Deliberately JS-side rather
// than native parsing S.recent out of the settings blob itself -- native
// treats that JSON as opaque and this reuses the exact openPath path a
// recent-files click already goes through. BOOT.hasDoc is false only when
// native had no CLI-argument document to hand off at boot (see main.cpp's
// BuildBootScript -- it reflects whatever OpenDocument() decided
// synchronously, before this script ever runs), so an explicit CLI file
// always wins over restoring; BOOT.solo restricts this to the first/only
// instance, so launching a second window while one is already open never
// silently swaps its document out from under the reader.
//
// Posted BEFORE 'ready', not after: both go over the same native message
// channel, so native processes this openPath first and already has
// g_haveDoc=true by the time it handles 'ready' -- avoiding a "Welcome"
// screen flash (native's ready handler sends 'nodoc' whenever g_haveDoc is
// still false at that instant) that a post-'ready' restore attempt would
// cause every single time, since the doc genuinely isn't open yet when
// 'ready' would otherwise be handled.
if (BOOT.solo && !BOOT.hasDoc && S.restoreLastDoc && S.recent.length) {
  post({ type: 'openPath', path: S.recent[0].path, nav: 'new' });
}

post({ type: 'ready' });

})();
