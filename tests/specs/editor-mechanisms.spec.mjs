// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- three
// editor-mechanism families that had ZERO coverage anywhere in this suite
// before this: continueBlock() (Enter-key list/quote continuation),
// tableTab() (Tab-key pipe-table cell navigation), and the editor
// toolbar's roving tabindex.
//
// continueBlock()/tableTab() are pure textarea-transform functions wired
// to the real #editor keydown handler (assets/app.js: `if (e.key === 'Tab')
// ... tableTab(e.shiftKey) ... indentSelection`; `if (e.key === 'Enter' ...
// continueBlock())`) -- driven here via mdv.setEditor() (content + caret)
// followed by a REAL Enter/Tab keypress on the focused #editor, rather than
// calling the __MDV_TEST-exposed continueBlock/tableTab directly, since the
// real key path is equally simple and exercises the actual event listener
// (including its e.preventDefault() gating) too. The "Tab outside a table"
// case in particular now asserts the real fallback behavior (Tab indents
// two spaces via indentSelection()) instead of the original's internal
// `tableTab(false) === false` return-value check -- a more end-to-end,
// user-visible claim.
//
// The roving-tabindex check needs no hook at all: it drives the real
// #editor-toolbar buttons with real focus + real ArrowRight/End keypresses,
// exactly like the original in-page version (which dispatched synthetic
// KeyboardEvents at document.activeElement).

import { test, expect } from '../harness/fixtures.mjs';

test.beforeEach(async ({ mdv }) => {
  await mdv.openDoc('# scratch\n', { name: 'editor-mechanisms.md' });
  await mdv.call('enterEdit');
});

test('continueBlock (Enter): inserting a new numbered item mid-list renumbers every item after it', async ({ mdv }) => {
  await mdv.setEditor('1. a\n2. b\n3. c', 4, 4);   // caret right after "1. a"
  await mdv.page.locator('#editor').focus();
  await mdv.page.keyboard.press('Enter');
  expect(await mdv.editorValue()).toBe('1. a\n2. \n3. b\n4. c');
});

test('continueBlock (Enter): carries a bullet marker to a new line at the end of a bullet item', async ({ mdv }) => {
  await mdv.setEditor('- item', 6, 6);
  await mdv.page.locator('#editor').focus();
  await mdv.page.keyboard.press('Enter');
  expect(await mdv.editorValue()).toBe('- item\n- ');
});

test('continueBlock (Enter): an empty item ends the list instead of continuing it', async ({ mdv }) => {
  await mdv.setEditor('- item\n- ', 9, 9);   // caret on the empty second item
  await mdv.page.locator('#editor').focus();
  await mdv.page.keyboard.press('Enter');
  expect(await mdv.editorValue()).toBe('- item\n');
});

test('tableTab (Tab): moves from one cell to the next cell in the same row, selecting its contents', async ({ mdv }) => {
  await mdv.setEditor('| A | B |\n| --- | --- |\n| 1 | 2 |', 2, 2);   // inside the "A" header cell
  await mdv.page.locator('#editor').focus();
  await mdv.page.keyboard.press('Tab');
  const { value, selected } = await mdv.page.evaluate(() => {
    const ed = window.__MDV_TEST.els.editor;
    return { value: ed.value, selected: ed.value.slice(ed.selectionStart, ed.selectionEnd).trim() };
  });
  expect(value).toContain('A');   // untouched by the move itself
  expect(selected).toBe('B');
});

test('tableTab (Tab): from the last cell of the last row adds a new row with the right number of columns', async ({ mdv }) => {
  const value = '| A | B |\n| --- | --- |\n| 1 | 2 |';
  const lastCellPos = value.lastIndexOf('2');
  const rowsBefore = value.split('\n').length;
  await mdv.setEditor(value, lastCellPos, lastCellPos);
  await mdv.page.locator('#editor').focus();
  await mdv.page.keyboard.press('Tab');
  const after = await mdv.editorValue();
  const newLines = after.split('\n');
  const lastLineCellCount = (newLines[newLines.length - 1].match(/\|/g) || []).length - 1;
  expect(newLines.length).toBe(rowsBefore + 1);
  expect(lastLineCellCount).toBe(2);
  expect(after).toContain('A');
  expect(after).toContain('1');
  expect(after).toContain('2');
});

test('Tab outside a table falls through to the normal two-space indent', async ({ mdv }) => {
  await mdv.setEditor('plain paragraph text', 3, 3);
  await mdv.page.locator('#editor').focus();
  await mdv.page.keyboard.press('Tab');
  expect(await mdv.editorValue()).toBe('pla  in paragraph text');
});

test('roving tabindex: ArrowRight moves the tab stop to the next toolbar button', async ({ mdv }) => {
  const buttons = mdv.page.locator('#editor-toolbar button[data-fmt]');
  await buttons.nth(0).focus();
  await mdv.page.keyboard.press('ArrowRight');
  await expect(buttons.nth(1)).toBeFocused();
  expect(await buttons.nth(1).getAttribute('tabindex')).toBe('0');
  expect(await buttons.nth(0).getAttribute('tabindex')).toBe('-1');
});

test('roving tabindex: End jumps the tab stop to the last toolbar button', async ({ mdv }) => {
  const buttons = mdv.page.locator('#editor-toolbar button[data-fmt]');
  await buttons.first().focus();
  await mdv.page.keyboard.press('End');
  await expect(buttons.last()).toBeFocused();
  expect(await buttons.last().getAttribute('tabindex')).toBe('0');
});
