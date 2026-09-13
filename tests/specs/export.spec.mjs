// Export as HTML / copy as rich text (docs/BACKLOG.md's Features #2). Both
// share renderableContentHtml() (app.js): whatever #content currently holds,
// with the copy button and live task-checkbox interactivity stripped, since
// neither means anything once the markup leaves this page.

import { test, expect } from '../harness/fixtures.mjs';

async function openMenuAndClick(mdv, act) {
  await mdv.page.locator('#btn-menu').click();
  await mdv.page.locator(`#menu-pop [data-act="${act}"]`).click();
}

test('Export as HTML sends a standalone document with the copy button and checkbox interactivity stripped', async ({ mdv }) => {
  await mdv.openDoc('# My Doc\n\n- [x] done\n\n```js\ncode();\n```\n', { name: 'export.md' });
  await openMenuAndClick(mdv, 'exporthtml');

  // exportHtml() is async (it may need to fetch/embed KaTeX assets -- see
  // katex-embed.spec.mjs -- though this particular document has no math,
  // so that step is skipped); its menu click handler doesn't await it, so
  // poll rather than assume the outbound message has already landed the
  // instant the click resolves.
  await expect.poll(() => mdv.lastSent('__exportedHtml')).toBeTruthy();
  const sent = mdv.lastSent('__exportedHtml');
  expect(sent.html).toContain('<!doctype html>');
  expect(sent.html).toContain('My Doc');       // the <title>
  expect(sent.html).toContain('done');         // real document content
  expect(sent.html).not.toContain('copybtn');  // interactive chrome stripped
  expect(sent.html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
});

test('Export as HTML does nothing when there is no document', async ({ mdv }) => {
  // Guarded twice, deliberately: exportHtml() itself checks doc.kind, and
  // separately FakeNative's own 'exportHtml' case checks s.haveDoc (mirroring
  // the real g_haveDoc check in main.cpp) -- so this exercises the same
  // defense-in-depth pattern already used for openExternal's scheme check,
  // not one specific layer.
  await mdv.call('exportHtml');
  expect(mdv.lastSent('__exportedHtml')).toBeUndefined();
});

test('the export/copy-rich-text menu items are hidden without a real document', async ({ mdv }) => {
  await mdv.page.locator('#btn-menu').click();
  await expect(mdv.page.locator('#menu-pop [data-act="exporthtml"]')).toBeHidden();
  await expect(mdv.page.locator('#menu-pop [data-act="exportpdf"]')).toBeHidden();
  await expect(mdv.page.locator('#menu-pop [data-act="copyrich"]')).toBeHidden();
});

test('Export as PDF posts an exportPdf message -- the real PDF write is native-only, covered by tools/regression.ps1\'s pdf-test scenario', async ({ mdv }) => {
  await mdv.openDoc('# My Doc\n\nBody.\n', { name: 'export-pdf.md' });
  await openMenuAndClick(mdv, 'exportpdf');
  expect(mdv.lastReceived('exportPdf')).toBeTruthy();
});

test('Export as PDF does nothing when there is no document', async ({ mdv }) => {
  await mdv.call('exportPdf');
  expect(mdv.lastReceived('exportPdf')).toBeUndefined();
});

test('Copy as rich text puts both HTML and plain text on the clipboard', async ({ mdv }) => {
  await mdv.page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://app.local' });
  await mdv.openDoc('# Rich Doc\n\nSome **bold** text.\n', { name: 'rich.md' });
  await openMenuAndClick(mdv, 'copyrich');
  // copyAsRichText() is async (awaits navigator.clipboard.write()) and its
  // menu click handler doesn't await it -- wait for the toast it posts on
  // success so the clipboard write has actually landed before reading it back.
  await expect(mdv.page.locator('#toast')).toContainText('Copied as rich text');

  const { html, text } = await mdv.page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items[0];
    const htmlBlob = await item.getType('text/html');
    const textBlob = await item.getType('text/plain');
    return { html: await htmlBlob.text(), text: await textBlob.text() };
  });
  expect(html).toContain('<strong>bold</strong>');
  expect(text).toContain('bold text');
});
