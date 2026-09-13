// docs/BACKLOG.md's Features #10: document info (encoding, BOM, line
// endings, size, modified) -- native (main.cpp) already tracked g_docBom/
// g_docCrlf for save-time preservation and computed file size/mtime for the
// watcher, but never sent any of it to the page. Now carried on the 'doc'
// message and shown in the F1 panel's document-info grid.

import { test, expect } from '../harness/fixtures.mjs';

test('the F1 panel shows the real encoding, line endings, size, and modified time', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\r\nSome text.\r\n', {
    name: 'info.md', encoding: 'UTF-16 LE', crlf: true, size: 12345, modified: 1700000000000,
  });
  await mdv.call('CMDS.help');

  const text = await mdv.page.locator('#help-docstats').innerText();
  expect(text).toContain('UTF-16 LE');
  expect(text).toContain('CRLF');
  expect(text).toContain('12.1 KB');
  expect(text).toContain(new Date(1700000000000).toLocaleString());
});

test('a plain LF UTF-8 document shows LF and a small byte size, not KB', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nSmall.\n', { name: 'small.md', crlf: false, size: 42 });
  await mdv.call('CMDS.help');

  const text = await mdv.page.locator('#help-docstats').innerText();
  expect(text).toContain('UTF-8');
  expect(text).toContain('LF');
  expect(text).toContain('42 B');
});

test('an untitled (never-saved) document shows a dash for modified time, not a bogus date', async ({ mdv }) => {
  const waitDone = mdv.waitForDebugLog('renderComplete');
  await mdv.call('CMDS.newDoc');
  await waitDone;
  await mdv.call('CMDS.help');
  const text = await mdv.page.locator('#help-docstats').innerText();
  expect(text).toContain('—');   // em dash
});

test('leaving the editor (previewing unsaved edits) does not lose the file\'s real document info', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nOriginal.\n', { name: 'preview.md', encoding: 'ANSI', crlf: true, size: 999 });
  await mdv.call('enterEdit');
  const waitDone = mdv.waitForDebugLog('renderComplete');
  await mdv.call('leaveEdit');
  await waitDone;
  await mdv.call('CMDS.help');

  const text = await mdv.page.locator('#help-docstats').innerText();
  expect(text).toContain('ANSI');
  expect(text).toContain('CRLF');
  expect(text).toContain('999 B');
});
