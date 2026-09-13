// Shared markdown-it configuration, used identically by the main thread
// (app.js) and the render worker (worker.js). Kept in one file so the two
// never drift apart. Works in both contexts: in a Window, `self === window`;
// in a Worker, `self` is the worker's global scope. Neither this file nor
// anything it configures touches the DOM — markdown-it, its plugins,
// highlight.js, and KaTeX's renderToString path are all pure string/token
// transforms, which is what makes moving the whole render onto a worker
// thread possible.

// Shared with worker.js so the two never drift on what counts as front
// matter — a document that renders one way on the main thread's sync path
// and another way through the worker would be a confusing, hard-to-spot bug.
self.mdvSplitFrontMatter = function mdvSplitFrontMatter(src) {
  const m = src.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!m) return { body: src, fm: null };
  // Guard against a document that merely opens with a `---` thematic break and
  // happens to contain another `---` later: only treat the block as front matter
  // if it actually looks like YAML (at least one `key: value` line).
  const looksYaml = m[1].split(/\r?\n/).some((line) => /^[ \t]*[\w][\w .-]*\s*:(\s|$)/.test(line));
  if (!looksYaml) return { body: src, fm: null };
  return { body: src.slice(m[0].length), fm: m[1] };
};

self.mdvCreateRenderer = function mdvCreateRenderer() {
  const md = self.markdownit({
    html: true,
    linkify: true,
    typographer: true,
    highlight: (str, lang) => {
      if (lang && self.hljs && self.hljs.getLanguage(lang)) {
        try { return self.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value; } catch (e) {}
      }
      return '';
    }
  });

  // data:image/svg+xml is safe in an <img> src (scripts never run in image
  // context, and DOMPurify guards everything else on the main thread), but
  // markdown-it's default whitelist only covers raster formats — extend it.
  const defaultValidateLink = md.validateLink.bind(md);
  md.validateLink = (url) => defaultValidateLink(url) || /^data:image\/svg\+xml[;,]/i.test(url);

  if (self.markdownitFootnote) md.use(self.markdownitFootnote);
  if (self.markdownitDeflist) md.use(self.markdownitDeflist);
  if (self.markdownitTaskLists) md.use(self.markdownitTaskLists, { enabled: true, label: true });
  if (self.markdownItAnchor) md.use(self.markdownItAnchor, { slugify: mdvSlugify });
  if (self.markdownitSub) md.use(self.markdownitSub);
  if (self.markdownitSup) md.use(self.markdownitSup);
  if (self.markdownitMark) md.use(self.markdownitMark);
  if (self.markdownitIns) md.use(self.markdownitIns);
  if (self.markdownitAbbr) md.use(self.markdownitAbbr);
  if (self.markdownitEmoji) md.use(self.markdownitEmoji.full || self.markdownitEmoji.light || self.markdownitEmoji);
  if (self.texmath && self.katex) {
    // 'dollars' = $…$ / $$…$$ plus the ```math fence — the GitHub/Obsidian set.
    // Bracket delimiters (\(…\), \[…\]) are deliberately NOT enabled: texmath's
    // bracket rules run before markdown's escape rule and would hijack
    // CommonMark backslash-escapes like \[ and \(. GitHub omits them too.
    md.use(self.texmath, {
      engine: self.katex,
      delimiters: 'dollars',
      katexOptions: { throwOnError: false, output: 'htmlAndMathml' }
    });
  }
  return md;
};

function mdvSlugify(s) {
  return s.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}
self.mdvSlugify = mdvSlugify;

// Split a parsed token stream into groups suitable for progressive,
// chunk-at-a-time rendering, at strictly top-level (nesting-neutral)
// boundaries — never inside a paragraph, table, list, or code fence.
// footnote/reference definitions are collected once during the shared parse
// pass and stay valid for every group's render() call via the shared `env`.
//
// Group SIZE is picked to keep the TOTAL number of groups roughly constant
// (targetChunkCount) regardless of document size, rather than a fixed
// number of blocks per group. This matters more than it might look: both
// markdown-it's renderer.render() (called once per group, in the worker)
// and DOMPurify.sanitize() (called once per group, on the main thread, as
// each is inserted) carry real fixed per-call overhead. A document with
// many small blocks — hundreds of short headings and paragraphs, say —
// chunked at a fixed few-blocks-per-group would produce thousands of
// groups, and thousands of calls to each of those, dominated entirely by
// that per-call overhead rather than the actual amount of text involved.
// Sizing by a target *count* instead keeps total call overhead bounded no
// matter how many small blocks the source happens to contain.
self.mdvChunkTokens = function mdvChunkTokens(tokens, targetChunkCount) {
  let totalBlocks = 0, depth = 0;
  for (const t of tokens) {
    if (t.nesting === 1) depth++;
    else if (t.nesting === -1) depth--;
    if (depth === 0) totalBlocks++;
  }
  const blocksPerChunk = Math.max(1, Math.ceil(totalBlocks / targetChunkCount));

  const groups = [];
  let cur = [];
  let blocksInCur = 0;
  depth = 0;
  for (const t of tokens) {
    cur.push(t);
    if (t.nesting === 1) depth++;
    else if (t.nesting === -1) depth--;
    if (depth === 0) {
      blocksInCur++;
      if (blocksInCur >= blocksPerChunk) { groups.push(cur); cur = []; blocksInCur = 0; }
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
};
