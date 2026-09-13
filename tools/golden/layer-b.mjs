// Layer B: normalized HTML, for a snapshot that's stable across cosmetic
// changes but still catches real rendering regressions.
//
// KaTeX's own generated markup for one formula is large (a parallel MathML
// tree plus a visual HTML tree, often 20+ nested spans) and would make
// nearly every snapshot diff on any KaTeX version bump, even when the
// actual rendered TeX source is identical -- collapsing each `.katex`
// subtree down to the TeX source already embedded in its own
// <annotation encoding="application/x-tex"> makes a real math-rendering
// regression (the annotation's own text changing, or math failing to
// render as `.katex` at all) show up in the diff, without every KaTeX
// internals refactor also showing up as noise.
//
// hljs spans are the opposite case -- real, app-specific syntax-
// highlighting output (which tokens got which class) worth pinning
// exactly -- so they're left untouched.

const KATEX_OPEN = '<span class="katex">';
const ANNOTATION_RE = /<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/;

/** Collapses every `.katex` subtree in `html` down to `[KATEX:<tex source>]`.
 *  Walks span-nesting depth manually rather than a naive non-greedy regex,
 *  since KaTeX's own output nests further <span> elements inside each
 *  `.katex` span (a naive `<span class="katex">[\s\S]*?<\/span>` would stop
 *  at the FIRST nested closing tag, not the matching one). */
export function normalizeHtml(html) {
  let result = '';
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf(KATEX_OPEN, i);
    if (start === -1) { result += html.slice(i); break; }
    result += html.slice(i, start);

    let depth = 0;
    let pos = start;
    while (pos < html.length) {
      const nextOpen = html.indexOf('<span', pos);
      const nextClose = html.indexOf('</span>', pos);
      if (nextClose === -1) { pos = html.length; break; }   // malformed; bail out
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        pos = html.indexOf('>', nextOpen) + 1;
      } else {
        depth--;
        pos = nextClose + '</span>'.length;
        if (depth === 0) break;
      }
    }

    const subtree = html.slice(start, pos);
    const m = subtree.match(ANNOTATION_RE);
    result += '[KATEX:' + (m ? m[1] : '?') + ']';
    i = pos;
  }
  return result;
}
