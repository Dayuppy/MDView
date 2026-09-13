// sourceHeadings() (assets/app.js) drives the editor-mode outline. Front
// matter's own key: value lines were never excluded from it the way
// renderMarkdownInto() already excludes them from the READ-mode outline
// (front matter renders separately, via buildFrontMatter()) -- a line
// immediately before front matter's closing "---" delimiter reads exactly
// like setext heading text with its underline right after, becoming a bogus
// section. docs/BACKLOG.md's Features #6.

import { test, expect } from '../harness/fixtures.mjs';

const DOC = '---\ntitle: My Doc\nauthor: Someone\n---\n\n# Real Heading\n\nBody text.\n';

test('front matter is not mistaken for a setext heading in the editor outline', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'fm.md' });

  const headings = await mdv.call('sourceHeadings', DOC);
  expect(headings).toHaveLength(1);
  expect(headings[0].text).toBe('Real Heading');
  expect(headings[0].level).toBe(1);

  // index must still land in the REAL document at the real heading -- not
  // just "one heading found", but found at the right offset, since
  // gotoSourceIndex() uses it to place the caret in the untouched editor
  // text (skipping the front-matter prefix must not shift everything after
  // it out of alignment).
  expect(DOC.slice(headings[0].index, headings[0].index + 14)).toBe('# Real Heading');
});

test('a document with no front matter is unaffected', async ({ mdv }) => {
  const doc = '# One\n\nBody.\n\nTwo\n---\n\nMore.\n';
  await mdv.openDoc(doc, { name: 'no-fm.md' });

  const headings = await mdv.call('sourceHeadings', doc);
  expect(headings.map((h) => h.text)).toEqual(['One', 'Two']);
  expect(headings[1].level).toBe(2);   // genuine setext heading, still recognized
});
