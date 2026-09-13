// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- two menu
// actions never exercised anywhere else: Print (delegates to
// window.print()) and Show in Explorer (posts a revealDoc message). Both
// are naturally reachable through the real UI; native.sent (the
// FakeNative mirror) already records every outgoing bridge message, so no
// manual bridge.postMessage stubbing is needed the way the original
// in-page test did it.

import { test, expect } from '../harness/fixtures.mjs';

test('menu Print calls window.print() and closes the menu', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'print.md' });
  await mdv.page.evaluate(() => { window.__printCalled = 0; window.print = () => { window.__printCalled++; }; });

  await mdv.page.locator('#btn-menu').click();
  await mdv.page.locator('#menu-pop [data-act="print"]').click();

  const printCalled = await mdv.page.evaluate(() => window.__printCalled);
  expect(printCalled).toBe(1);
  await expect(mdv.page.locator('#menu-pop')).toBeHidden();
});

test('menu Show in Explorer posts a revealDoc message', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'reveal.md' });
  await mdv.page.locator('#btn-menu').click();

  const revealBtn = mdv.page.locator('#menu-pop [data-act="reveal"]');
  await expect(revealBtn).toBeVisible();
  await revealBtn.click();

  // FakeNative echoes a received revealDoc message back as
  // __revealedInExplorer (the same "record intent, never perform the real
  // OS-level thing" convention openExternal/exportHtml use) -- this is
  // what exercises the real send, not revealDoc itself (native.sent only
  // ever holds outbound, native -> page messages).
  const msg = mdv.lastSent('__revealedInExplorer');
  expect(msg).toBeTruthy();
});
