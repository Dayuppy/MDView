// Embeds KaTeX's CSS + fonts (base64 WOFF2 data URIs) into the HTML export
// so math renders styled instead of unstyled/broken-looking spans
// (docs/BACKLOG.md's Features item). Only done when the document actually
// contains math -- a document with none would otherwise carry ~300KB of
// embedded font data it never uses.

import { test, expect } from '../harness/fixtures.mjs';

async function openMenuAndClick(mdv, act) {
  await mdv.page.locator('#btn-menu').click();
  await mdv.page.locator(`#menu-pop [data-act="${act}"]`).click();
}

test('a document with math gets KaTeX\'s CSS + fonts embedded as base64 data URIs', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nInline $x^2$ math.\n', { name: 'katex-embed.md' });
  await openMenuAndClick(mdv, 'exporthtml');
  await expect.poll(() => mdv.lastSent('__exportedHtml')).toBeTruthy();
  const { html } = mdv.lastSent('__exportedHtml');

  expect(html).toMatch(/@font-face/);
  expect(html).toMatch(/src:url\(data:font\/woff2;base64,[A-Za-z0-9+/]+=*\) format\("woff2"\)/);
  // The vendored CSS's own relative font urls (which a standalone file
  // couldn't resolve -- no app.local origin to serve them from) must not
  // survive into the export.
  expect(html).not.toMatch(/url\(fonts\//);
  // The math itself is still there, real KaTeX markup, not stripped.
  expect(html).toMatch(/class="katex"/);
});

test('a document with no math carries no KaTeX CSS/font data at all', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nJust plain text, no formulas.\n', { name: 'katex-embed-none.md' });
  await openMenuAndClick(mdv, 'exporthtml');
  await expect.poll(() => mdv.lastSent('__exportedHtml')).toBeTruthy();
  const { html } = mdv.lastSent('__exportedHtml');

  expect(html).not.toMatch(/@font-face/);
  expect(html).not.toMatch(/KaTeX/);
});
