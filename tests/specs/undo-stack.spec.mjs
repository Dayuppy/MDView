// Migrated from debugRunEditorTest() (assets/app.js, formerly ~570-609) -- see
// tests/MIGRATION.md. replaceRange() (shared by every toolbar action, and by
// replaceCurrent()'s single-match Replace) prefers
// document.execCommand('insertText', ...) specifically so a real edit lands
// on the textarea's native undo stack, with editor.setRangeText() as a
// documented "last resort; loses undo" fallback -- but comparing only the
// resulting editor.value (as toolbar.spec.mjs and a plain replace check do)
// can't tell the two paths apart, since both produce identical text. These
// two tests verify the undo stack directly: document.execCommand('undo') is
// the standard way a script can trigger the same native undo a real Ctrl+Z
// would (a synthetic KeyboardEvent is not a trusted event and textareas
// ignore it for native editing commands). One representative toolbar action
// (bold) is enough since every toolbar action funnels through the same
// replaceRange(); the single-match Replace path is checked separately since
// replaceCurrent() used to call editor.setRangeText() directly, bypassing
// replaceRange() entirely (replaceAll() already routed through it and was
// fine).
//
// Both driven through the real UI end-to-end (real toolbar button click;
// real #btn-find -> #find-input -> #replace-input -> #replace-one) rather
// than calling replaceCurrent()/collectMatches()/findOpts() directly, since
// that path is equally simple to drive for real and exercises the actual
// find/replace wiring along the way.

import { test, expect } from '../harness/fixtures.mjs';

test.beforeEach(async ({ mdv }) => {
  await mdv.openDoc('# scratch\n', { name: 'undo-stack.md' });
  await mdv.call('enterEdit');
});

test('bold: a real toolbar click lands on the native undo stack (Ctrl+Z reverts it)', async ({ mdv }) => {
  await mdv.setEditor('hello world', 0, 5);
  await mdv.page.click('#editor-toolbar button[data-fmt="bold"]');
  expect(await mdv.editorValue()).toBe('**hello** world');

  await mdv.page.evaluate(() => document.execCommand('undo'));
  expect(await mdv.editorValue()).toBe('hello world');
});

test('replace: a real single Replace swaps only the current match and lands on the native undo stack', async ({ mdv }) => {
  await mdv.setEditor('one fox two fox three', 0, 0);
  await mdv.page.click('#btn-find');
  await mdv.page.locator('#find-input').fill('fox');
  // find-input's own 'input' handler debounces runSearch by 130ms -- poll
  // state() rather than a fixed wait.
  await expect.poll(async () => (await mdv.state()).matches.length).toBe(2);

  await mdv.page.locator('#replace-input').fill('cat');
  await mdv.page.click('#replace-one');
  expect(await mdv.editorValue()).toBe('one cat two fox three');

  await mdv.page.evaluate(() => document.execCommand('undo'));
  expect(await mdv.editorValue()).toBe('one fox two fox three');
});
