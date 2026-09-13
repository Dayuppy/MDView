// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- renderRecent()
// rebuilds the whole recent-files list on every removal, destroying the
// button that was just clicked/focused; without an explicit refocus, that
// silently drops focus to <body>. The recent list lives inside #welcome,
// which is hidden whenever a document is loaded, so the welcome screen has
// to actually be shown for a real (not hidden-ancestor no-op) focus() to
// land anywhere.

import { test, expect } from '../harness/fixtures.mjs';

async function showWelcome(mdv) {
  await mdv.page.evaluate(() => {
    window.__MDV_TEST.els.welcome.hidden = false;
    window.__MDV_TEST.els.content.hidden = true;
  });
}

test('removing a middle recent-file entry moves focus to the next remove button, not <body>', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'recent-mid.md' });
  await showWelcome(mdv);
  await mdv.call('setRecent', [
    { path: 'C:/a.md', name: 'a.md' }, { path: 'C:/b.md', name: 'b.md' }, { path: 'C:/c.md', name: 'c.md' },
  ]);
  await mdv.call('renderRecent');

  const xs = mdv.page.locator('#recent-list .recent-x');
  await xs.nth(1).click();

  await expect(mdv.page.locator('#recent-list .recent-x')).toHaveCount(2);
  await expect(mdv.page.locator('#recent-list .recent-x').nth(1)).toBeFocused();
});

test('removing the last recent-file entry falls back to focusing "Open a file"', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'recent-last.md' });
  await showWelcome(mdv);
  await mdv.call('setRecent', [{ path: 'C:/only.md', name: 'only.md' }]);
  await mdv.call('renderRecent');

  await mdv.page.locator('#recent-list .recent-x').click();

  await expect(mdv.page.locator('#btn-open')).toBeFocused();
});
