// Off-main-thread rendering. markdown-it, its plugins, highlight.js, and
// KaTeX's string-output path are all pure computation with no DOM
// dependency, so the entire expensive part of turning Markdown source into
// HTML — parsing, syntax highlighting, and math typesetting — happens here
// instead of blocking the page. The main thread only does the DOM-bound
// work: sanitizing and inserting the HTML this worker hands back.
//
// This worker instance is reused across documents for as long as the page
// lives — nothing here holds per-document state beyond the lifetime of a
// single onmessage call, so there's nothing to reset between renders. app.js
// only ever has one render in flight at a time (a newer request terminates
// an unfinished older one rather than queuing behind it), so no message-id
// bookkeeping is needed.

importScripts(
  'vendor/markdown-it.min.js',
  'vendor/markdown-it-footnote.min.js',
  'vendor/markdown-it-deflist.min.js',
  'vendor/markdown-it-task-lists.min.js',
  'vendor/markdown-it-anchor.umd.min.js',
  'vendor/markdown-it-sub.min.js',
  'vendor/markdown-it-sup.min.js',
  'vendor/markdown-it-mark.min.js',
  'vendor/markdown-it-ins.min.js',
  'vendor/markdown-it-abbr.min.js',
  'vendor/markdown-it-emoji.min.js',
  'vendor/katex.min.js',
  'vendor/mhchem.min.js',
  'vendor/texmath.min.js',
  'vendor/highlight.min.js',
  'vendor/lang-powershell.min.js',
  'vendor/lang-dos.min.js',
  'vendor/lang-dockerfile.min.js',
  'vendor/lang-cmake.min.js',
  'vendor/lang-x86asm.min.js',
  'vendor/lang-nginx.min.js',
  'md-setup.js'
);

const md = self.mdvCreateRenderer();

const TARGET_CHUNK_COUNT = 40;   // see mdvChunkTokens's comment in md-setup.js

// `text` arrives already front-matter-stripped -- renderMarkdownInto()
// (app.js) calls splitFrontMatter() once and only ever hands this worker
// the resulting body, never the raw source. This handler used to call
// splitFrontMatter() again anyway (a pure no-op re-scan of text already
// guaranteed not to contain it) and to compute a `headings` array via its
// own extractHeadings()/inlineToLabel() helpers -- real per-heading work
// (a full renderInline() + five regex replacements each) whose result was
// never read anywhere in app.js. Deleted; nothing else in this file used
// either the front-matter re-split or the headings computation.
self.onmessage = (e) => {
  const body = e.data.text;
  const t0 = performance.now();
  try {
    const env = {};
    const tokens = md.parse(body, env);
    const groups = self.mdvChunkTokens(tokens, TARGET_CHUNK_COUNT);
    const chunks = groups.map((g) => md.renderer.render(g, md.options, env));
    self.postMessage({ ok: true, chunks, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err), ms: performance.now() - t0 });
  }
};
