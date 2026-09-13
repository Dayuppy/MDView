// F11 fullscreen already hid the OS window chrome, but this app's own
// topbar/status bar stayed fully visible -- not a true distraction-free
// "zen" reading mode. docs/BACKLOG.md's Features #12. Native's real
// ToggleFullscreen() can't be driven from this harness (no real window), so
// this simulates the 'fs' message it sends back, exactly the way the app
// itself receives it.

import { test, expect } from '../harness/fixtures.mjs';

test('fullscreen hides the topbar and status bar; exiting brings them back', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nSome text.\n', { name: 'zen.md' });
  await expect(mdv.page.locator('#topbar')).toBeVisible();
  await expect(mdv.page.locator('#statusbar')).toBeVisible();

  await mdv.page.evaluate(() => window.__mdvDeliver({ type: 'fs', on: '1' }));
  await expect(mdv.page.locator('#topbar')).toBeHidden();
  await expect(mdv.page.locator('#statusbar')).toBeHidden();
  // The content itself is unaffected -- this hides app chrome, not the document.
  await expect(mdv.page.locator('#content')).toBeVisible();

  await mdv.page.evaluate(() => window.__mdvDeliver({ type: 'fs', on: '0' }));
  await expect(mdv.page.locator('#topbar')).toBeVisible();
  await expect(mdv.page.locator('#statusbar')).toBeVisible();
});
