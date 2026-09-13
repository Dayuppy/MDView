// tools/golden/render-node.mjs loads the real markdown pipeline (assets/md-setup.js
// + every vendored library) into a pure-Node vm context -- no browser, no exe.
// This is the foundation the golden-snapshot layer and the fast renderer
// benchmark both build on, so it gets its own direct verification first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml, parseToTokens, loadRenderer } from '../../tools/golden/render-node.mjs';

// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- these are pure
// renderer-logic checks with zero DOM/editor dependency, so they belong here
// (~200ms for the whole file) rather than in a Playwright spec (a real
// browser launch per run).

// Placed FIRST, deliberately: this needs to be the very first thing in this
// file to call loadRenderer(), so the module-level cache is still genuinely
// cold -- every later test's own loadRenderer() call would trivially return
// the identical already-cached instance regardless of whether this specific
// concurrent-call race is actually closed, since node --test runs tests
// within one file sequentially in declaration order.
test('loadRenderer: two concurrent callers before the first build finishes still get the identical instance', async () => {
  const [a, b] = await Promise.all([loadRenderer(), loadRenderer()]);
  assert.equal(a.md, b.md, 'racing callers must await the same in-flight build, not each start their own separate vm context');
});

test('loadRenderer: real vendor libraries actually landed on self, not just md-setup.js\'s own exports', async () => {
  const { sandbox } = await loadRenderer();
  assert.equal(typeof sandbox.markdownit, 'function', 'markdown-it core');
  assert.equal(typeof sandbox.katex, 'object', 'KaTeX');
  assert.equal(typeof sandbox.hljs, 'object', 'highlight.js');
  assert.equal(typeof sandbox.texmath, 'function', 'texmath (a markdown-it plugin function)');
  assert.equal(typeof sandbox.markdownitFootnote, 'function', 'markdown-it-footnote plugin');
});

test('renderHtml: heading gets a real anchor id (markdown-it-anchor actually ran)', async () => {
  const html = await renderHtml('# Hello World\n');
  assert.match(html, /<h1 id="hello-world"/);
});

test('renderHtml: inline math renders through the real KaTeX, not left as literal $...$', async () => {
  const html = await renderHtml('$x^2$\n');
  assert.match(html, /class="katex"/);
  assert.match(html, /<annotation encoding="application\/x-tex">x\^2<\/annotation>/);
});

test('renderHtml: fenced code gets real hljs spans for a recognized language', async () => {
  const html = await renderHtml('```js\nconsole.log(1)\n```\n');
  assert.match(html, /class="hljs-/);
});

test('renderHtml: bracket-delimited math stays a literal backslash-escape (README\'s documented divergence)', async () => {
  const html = await renderHtml('\\(x^2\\)\n');
  assert.equal(html.trim(), '<p>(x^2)</p>');
});

test('parseToTokens: returns the real markdown-it token stream, not a reimplementation', async () => {
  const { tokens } = await parseToTokens('# Title\n\nBody text.\n');
  // `tokens` is an Array from INSIDE the vm context -- a different realm
  // than this test's own Array, so deepStrictEqual's constructor/prototype
  // check fails even for identical-looking contents ("same structure but
  // not reference-equal", a real cross-realm gotcha worth documenting
  // since every golden-layer consumer of this loader will hit it too).
  // Compare as plain strings, converted in THIS realm via String(), to
  // sidestep the realm boundary entirely.
  const types = Array.from(tokens, (t) => String(t.type));
  assert.deepEqual(types, ['heading_open', 'inline', 'heading_close', 'paragraph_open', 'inline', 'paragraph_close']);
  assert.equal(String(tokens[0].tag), 'h1');
});

test('loadRenderer: caches -- a second call returns the identical renderer instance', async () => {
  const a = await loadRenderer();
  const b = await loadRenderer();
  assert.equal(a.md, b.md, 'building the vm context and compiling every vendor file is real work; must not repeat it per call');
});

test('highlight: an unrecognized fence language falls back to escaped plain text, not broken or unescaped HTML', async () => {
  const html = await renderHtml('```notreallanguage\n<b>x</b> & "y"\n```\n');
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; &amp; &quot;y&quot;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

test('highlight: a recognized fence language actually gets real hljs spans', async () => {
  const html = await renderHtml('```javascript\nconst x = 1;\n```\n');
  assert.match(html, /class="hljs-keyword"/);
});

test('highlight: a hostile-looking fence info string can\'t break out of the class attribute', async () => {
  // markdown-it's own fence renderer builds class="language-X" from the info
  // string -- this exercises THAT escaping, not any app-specific code.
  const html = await renderHtml('```"><script>alert(1)</script>\ncode\n```\n');
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /"\s*><script/);
});

test('mdvSplitFrontMatter: front matter detection handles the documented edge cases', async () => {
  const { mdvSplitFrontMatter } = await loadRenderer();
  const cases = [
    ['basic front matter', '---\ntitle: Test\n---\nBody text', 'title: Test', 'Body text'],
    ['a plain "---" thematic break is NOT mistaken for front matter',
      '---\njust a paragraph\n---\nmore text', null, '---\njust a paragraph\n---\nmore text'],
    ['CRLF line endings', '---\r\ntitle: Test\r\n---\r\nBody', 'title: Test', 'Body'],
    ['front matter with no body after it', '---\ntitle: Test\n---', 'title: Test', ''],
  ];
  for (const [name, src, expectFm, expectBody] of cases) {
    const { body, fm } = mdvSplitFrontMatter(src);
    assert.equal(fm, expectFm, `${name}: fm`);
    assert.equal(body, expectBody, `${name}: body`);
  }
});

test('renderHtml: emoji shortcode renders as an actual emoji, not literal text', async () => {
  const html = await renderHtml(':smile:');
  assert.doesNotMatch(html, /:smile:/, 'the emoji button\'s placeholder is only useful if this build actually recognizes the shortcode, not just parses it as syntactically valid Markdown that renders back as literal text');
});

// A representative spread of CommonMark/GFM edge cases that interact with
// this app's specific renderer config (typographer, linkify, html:true,
// the plugin set in md-setup.js) rather than generic spec compliance
// markdown-it already gets right on its own -- a guard against a future
// vendored-library update silently changing this behavior.
test('renderHtml: CommonMark/GFM edge cases against this app\'s configured renderer', async () => {
  const cases = [
    ['mid-word * emphasis is allowed', '5*6*78', /5<em>6<\/em>78/],
    ['mid-word _ emphasis is NOT allowed', '5_6_78', /^<p>5_6_78<\/p>/],
    ['hard break: two trailing spaces', 'a  \nb', /a<br>\nb/],
    ['hard break: backslash', 'a\\\nb', /a<br>\nb/],
    ['ref link matches case-insensitively', '[Foo]\n\n[foo]: /url', /<a href="\/url">Foo<\/a>/],
    ['ordered list keeps its start number', '3. a\n4. b', /<ol start="3">/],
    ['tight list has no <p> wrapper', '- a\n- b', /<li>a<\/li>/],
    ['loose list wraps items in <p>', '- a\n\n- b', /<li>\s*<p>a<\/p>\s*<\/li>/],
    ['typographer skips code spans', '`"literal"`', /<code>&quot;literal&quot;<\/code>/],
    ['GFM table renders', '|a|b|\n|-|-|\n|1|2|', /<table>/],
    ['fenced code with backtick content needs a tilde fence', '~~~\n```\n~~~', /<pre><code>```/],
    // README's own "Two deliberate divergences" callout: a single tilde is
    // subscript, so strikethrough needs double tildes -- documented as
    // noteworthy specifically because it's non-standard, but never actually
    // verified against the real, configured renderer (markdown-it-sub is
    // enabled alongside markdown-it's own built-in GFM strikethrough; a
    // single-tilde string is genuinely ambiguous between "an unclosed
    // strikethrough attempt" and "a real subscript" without this app's own
    // specific plugin configuration deciding it).
    ['single tilde is a subscript, not a broken strikethrough attempt', 'H~2~O', /H<sub>2<\/sub>O/],
    ['double tilde is still strikethrough despite the subscript plugin being active', '~~struck~~', /<s>struck<\/s>/],
    // README's SECOND deliberate divergence: bracket-delimited math
    // (\(...\), \[...\]) is intentionally NOT enabled -- texmath is
    // configured with delimiters:'dollars' only (md-setup.js) -- specifically
    // because those delimiters collide with CommonMark's own \( \[
    // backslash-escape syntax. Never verified that this actually holds: does
    // \(x^2\) really stay a literal escaped parenthesis, or does texmath
    // intercept it anyway despite the delimiters config?
    ['bracket-delimited math is deliberately not enabled -- backslash-escaped parens stay literal', '\\(x^2\\)', /^<p>\(x\^2\)<\/p>/]
  ];
  for (const [name, src, re] of cases) {
    const html = await renderHtml(src);
    assert.match(html, re, `${name}: got=${JSON.stringify(html)}`);
  }
});
