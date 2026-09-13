// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- the
// application menu (#menu-pop), role="menu"/"menuitem" with its own roving
// keyboard nav and click-outside-to-close, driven through the real UI
// (click #btn-menu, real keyboard/pointer events) rather than calling
// openMenu() internally -- unlike the mermaid-recovery migration, every
// path here IS naturally reachable through ordinary user interaction.

import { test, expect } from '../harness/fixtures.mjs';

// The same visible-items list the handler itself computes, rather than
// hardcoding which specific action is "first" or "last" -- doesn't depend
// on which items happen to be hidden for the current document state.
function visibleMenuItems(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#menu-pop button'))
      .filter((b) => b.style.display !== 'none')
      .map((b) => b.dataset.act));
}

test('opening the menu focuses the first visible item', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'menu.md' });
  await mdv.page.locator('#btn-menu').click();
  const items = await visibleMenuItems(mdv.page);
  const active = await mdv.page.evaluate(() => document.activeElement.dataset.act);
  expect(active).toBe(items[0]);
});

test('ArrowDown moves to the next visible item, ArrowUp from the first wraps to the last', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'menu-nav.md' });
  await mdv.page.locator('#btn-menu').click();
  const items = await visibleMenuItems(mdv.page);

  await mdv.page.keyboard.press('ArrowDown');
  let active = await mdv.page.evaluate(() => document.activeElement.dataset.act);
  expect(active).toBe(items[1]);

  await mdv.page.keyboard.press('ArrowUp');
  await mdv.page.keyboard.press('ArrowUp');
  active = await mdv.page.evaluate(() => document.activeElement.dataset.act);
  expect(active).toBe(items[items.length - 1]);
});

test('Escape closes the menu and returns focus to the menu button', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'menu-escape.md' });
  await mdv.page.locator('#btn-menu').click();
  await mdv.page.keyboard.press('Escape');
  await expect(mdv.page.locator('#menu-pop')).toBeHidden();
  await expect(mdv.page.locator('#btn-menu')).toBeFocused();
});

test('pointerdown inside the menu stays open; pointerdown outside closes it', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'menu-outside.md' });
  await mdv.page.locator('#btn-menu').click();
  await mdv.page.locator('#menu-pop').dispatchEvent('pointerdown', { bubbles: true });
  await expect(mdv.page.locator('#menu-pop')).toBeVisible();

  await mdv.page.locator('body').dispatchEvent('pointerdown', { bubbles: true });
  await expect(mdv.page.locator('#menu-pop')).toBeHidden();
});
