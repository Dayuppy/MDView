// Migrated from debugRunEditorTest()'s toolbar-action table (assets/app.js,
// formerly ~1012-1074) -- see tests/MIGRATION.md. Every one of the 25
// TOOLBAR_ACTIONS entries plus 3 regression cases (a fresh-eyes review pass,
// 2026-08-23), reproduced with identical fixtures and expected output.
//
// Deliberately clicks the REAL toolbar button by its data-fmt attribute
// (not TOOLBAR_ACTIONS[action] directly) -- a mismatched data-fmt in
// index.html would go undetected calling the map by its own key. This is
// the exact mechanism that has to keep working for the "21 buttons" stale-
// comment class of drift to be catchable at all.

import { test, expect } from '../harness/fixtures.mjs';

const CASES = [
  ['heading: paragraph -> H1', 'Some text', 0, 0, 'heading', '# Some text'],
  ['heading: H1 -> H2', '# Some text', 0, 0, 'heading', '## Some text'],
  ['heading: H6 -> paragraph', '###### Some text', 0, 0, 'heading', 'Some text'],
  ['bold', 'hello world', 0, 5, 'bold', '**hello** world'],
  ['italic', 'hello world', 0, 5, 'italic', '*hello* world'],
  ['strike', 'x', 0, 1, 'strike', '~~x~~'],
  ['code', 'y', 0, 1, 'code', '`y`'],
  ['ul', 'a\nb', 0, 3, 'ul', '- a\n- b'],
  ['ol', 'a\nb', 0, 3, 'ol', '1. a\n2. b'],
  ['task', 'a\nb', 0, 3, 'task', '- [ ] a\n- [ ] b'],
  ['quote', 'a\nb', 0, 3, 'quote', '> a\n> b'],
  ['link', '', 0, 0, 'link', '[link text](url)'],
  ['image', '', 0, 0, 'image', '![alt text](url)'],
  ['codeblock', 'code here', 0, 9, 'codeblock', '```\ncode here\n```'],
  ['sub', 'x2', 1, 2, 'sub', 'x~2~'],
  ['sup', 'x2', 1, 2, 'sup', 'x^2^'],
  ['math', '', 0, 0, 'math', '$x^2$'],
  ['mathblock', '', 0, 0, 'mathblock', '```math\nx^2 + y^2 = z^2\n```'],
  ['mermaid', '', 0, 0, 'mermaid', '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```'],
  ['footnote: reference + definition', 'Some text', 9, 9, 'footnote', 'Some text[^1]\n\n[^1]: '],
  // Second click on a doc that already has [^1] should pick [^2], not collide.
  // Caret at 11 is right after the existing "[^1]" marker.
  ['footnote: numbering skips an existing [^1]',
    'A claim[^1] and another.\n\n[^1]: first note', 11, 11, 'footnote',
    'A claim[^1][^2] and another.\n\n[^1]: first note\n\n[^2]: '],
  ['deflist', '', 0, 0, 'deflist', 'Term\n: Definition\n'],
  ['abbr', '', 0, 0, 'abbr', '*[abbr]: Full expansion\n'],
  ['mark', 'x', 0, 1, 'mark', '==x=='],
  ['ins', 'x', 0, 1, 'ins', '++x++'],
  ['emoji', '', 0, 0, 'emoji', ':smile:'],
  // Regression cases (fresh-eyes review pass, 2026-08-23): insertAtCaret
  // used to ignore selectionEnd entirely, leaving a real selection dangling
  // right after the inserted template instead of replacing it.
  ['hr consumes a non-collapsed selection', 'keep this text', 5, 9, 'hr', 'keep \n\n---\n\n text'],
  // prefixLines used to over-include a line when the selection ended
  // exactly at the next line's start (e.g. a Shift+Down that highlighted
  // the previous line plus its newline, but none of the next line).
  ["ul: selection ending at next line's start doesn't prefix that line too",
    'AAA\nBBB\nCCC', 1, 4, 'ul', '- AAA\nBBB\nCCC'],
  // insertFencedBlock used to wrap with a plain 3-backtick fence
  // unconditionally, which a selection already containing ``` would
  // prematurely close -- CommonMark's own rule (closer >= opener length)
  // says the wrapping fence must grow past the longest run inside.
  ['codeblock grows the fence past a nested ``` in the selection',
    'inner ``` fence', 0, 15, 'codeblock', '````\ninner ``` fence\n````'],
];

test.beforeEach(async ({ mdv }) => {
  await mdv.openDoc('# scratch\n', { name: 'toolbar.md' });
  await mdv.call('enterEdit');
});

for (const [name, value, selStart, selEnd, action, expected] of CASES) {
  test(`toolbar: ${name}`, async ({ mdv }) => {
    await mdv.setEditor(value, selStart, selEnd);
    await mdv.page.click(`#editor-toolbar button[data-fmt="${action}"]`);
    expect(await mdv.editorValue()).toBe(expected);
  });
}

// table's expected output uses .includes(), not exact equality, in the
// original -- formatTableLines() output has whitespace padding not worth
// pinning exactly.
test('toolbar: table', async ({ mdv }) => {
  await mdv.setEditor('', 0, 0);
  await mdv.page.click('#editor-toolbar button[data-fmt="table"]');
  const v = await mdv.editorValue();
  expect(v).toContain('| Column 1 | Column 2 |');
  expect(v).toContain('| --- | --- |');
});

test('toolbar: hr', async ({ mdv }) => {
  await mdv.setEditor('', 0, 0);
  await mdv.page.click('#editor-toolbar button[data-fmt="hr"]');
  expect(await mdv.editorValue()).toContain('---');
});
