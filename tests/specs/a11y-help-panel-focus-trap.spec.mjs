// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- the a11y and
// help overlay panels' shared focus trap (one first/last/Tab/Shift+Tab loop,
// reused by both panels via a single `for (const name of ['a11y', 'help'])`
// wiring block in app.js). The a11y panel has its own dedicated toolbar
// button (#btn-a11y) that stays visible and focusable throughout, so its
// whole suite -- open, Tab-wrap, Shift+Tab-wrap, Escape-close/focus-restore,
// backdrop-click -- is driven through real UI the way
// lightbox-focus-trap.spec.mjs drives the lightbox's identical trap. The
// help panel has no dedicated button of its own; it's reached through the
// application menu's "Help & shortcuts" action, the same way
// menu-print-reveal.spec.mjs reaches Print/Reveal -- covered here with one
// real-menu-click test for reachability/open, plus one focus-restore test
// that opens through the already-exposed openPanel() hook instead (a real
// click on the menu item is not a stable "opener" to observe afterward: the
// menu -- and that same button -- closes as a side effect of the very click
// that opens the panel, the same class of problem lightbox-focus-trap.spec.mjs
// hit with its no-tabindex <img>, solved there the same way).

import { test, expect } from '../harness/fixtures.mjs';

async function openA11yPanel(mdv) {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'a11y-panel.md' });
  await mdv.page.locator('#btn-a11y').click();
  await expect(mdv.page.locator('#a11y-overlay')).toBeVisible();
}

test('opening the a11y panel focuses the first real focusable control', async ({ mdv }) => {
  await openA11yPanel(mdv);
  await expect(mdv.page.locator('#a11y-overlay [data-close="a11y"]')).toBeFocused();
});

test('Tab from the last focusable control wraps to the first', async ({ mdv }) => {
  await openA11yPanel(mdv);
  await mdv.page.locator('#set-reset').focus();
  await mdv.page.keyboard.press('Tab');
  await expect(mdv.page.locator('#a11y-overlay [data-close="a11y"]')).toBeFocused();
});

test('Shift+Tab from the first focusable control wraps to the last', async ({ mdv }) => {
  await openA11yPanel(mdv);
  await mdv.page.locator('#a11y-overlay [data-close="a11y"]').focus();
  await mdv.page.keyboard.press('Shift+Tab');
  await expect(mdv.page.locator('#set-reset')).toBeFocused();
});

test('Escape closes the a11y panel and returns focus to whatever opened it', async ({ mdv }) => {
  await openA11yPanel(mdv);
  await mdv.page.keyboard.press('Escape');
  await expect(mdv.page.locator('#a11y-overlay')).toBeHidden();
  await expect(mdv.page.locator('#btn-a11y')).toBeFocused();
});

test('pointerdown inside the a11y dialog stays open; pointerdown on the backdrop closes it', async ({ mdv }) => {
  await openA11yPanel(mdv);
  await mdv.page.locator('#a11y-panel').dispatchEvent('pointerdown', { bubbles: true });
  await expect(mdv.page.locator('#a11y-overlay')).toBeVisible();

  await mdv.page.locator('#a11y-overlay').dispatchEvent('pointerdown', { bubbles: true });
  await expect(mdv.page.locator('#a11y-overlay')).toBeHidden();
});

test('the Help menu action opens the help panel', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'help-panel-open.md' });
  await mdv.page.locator('#btn-menu').click();
  await mdv.page.locator('#menu-pop [data-act="help"]').click();
  await expect(mdv.page.locator('#help-overlay')).toBeVisible();
  await expect(mdv.page.locator('#menu-pop')).toBeHidden();
  await expect(mdv.page.locator('#help-overlay [data-close="help"]')).toBeFocused();
});

test('Escape closes the help panel and returns focus to whatever opened it', async ({ mdv }) => {
  // See the file header: a real menu click isn't a stable "opener" for this
  // check (the clicked button closes with the menu, the same tick it opens
  // the panel), so this establishes a real, distinct opener via a genuine
  // .focus() call and opens through openPanel() (already exposed on
  // __MDV_TEST) instead -- the shared trap/open/close code was just
  // exhaustively verified via the a11y panel above, this is the literal
  // same path.
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'help-panel-focus-restore.md' });
  await mdv.page.locator('#btn-a11y').focus();
  await mdv.call('openPanel', 'help');
  await expect(mdv.page.locator('#help-overlay')).toBeVisible();

  await mdv.page.keyboard.press('Escape');
  await expect(mdv.page.locator('#help-overlay')).toBeHidden();
  await expect(mdv.page.locator('#btn-a11y')).toBeFocused();
});
