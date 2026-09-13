// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- the sidebar
// resizer's keyboard (ArrowRight/Shift+ArrowLeft/Home) and pointer-drag
// (pointerdown/move/up, dblclick-to-reset) operability. role="separator"
// with aria-valuenow looked correctly built by inspection, but "looks
// right" isn't verified until the actual handlers are driven and the
// resulting width/attribute are checked.

import { test, expect } from '../harness/fixtures.mjs';

test('ArrowRight/Shift+ArrowLeft/Home resize the sidebar and keep aria-valuenow in sync', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'resize.md' });
  await mdv.call('setSidebar', true, false);
  await mdv.call('applySidebarWidth', 300);   // a known starting point away from the 180/520 clamps

  const resizer = mdv.page.locator('#sidebar-resizer');
  await resizer.dispatchEvent('keydown', { key: 'ArrowRight', bubbles: true });
  expect((await mdv.state()).S.sidebarWidth).toBe(316);

  await resizer.dispatchEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true });
  expect((await mdv.state()).S.sidebarWidth).toBe(268);

  await resizer.dispatchEvent('keydown', { key: 'Home', bubbles: true });
  const { S, DEFAULTS } = await mdv.state();
  expect(S.sidebarWidth).toBe(DEFAULTS.sidebarWidth);
  await expect(resizer).toHaveAttribute('aria-valuenow', String(S.sidebarWidth));
});

test('pointer-drag resizes the sidebar and cleans up its dragging state; double-click resets it', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'resize-drag.md' });
  await mdv.call('setSidebar', true, false);
  await mdv.call('applySidebarWidth', 300);

  const resizer = mdv.page.locator('#sidebar-resizer');
  const box = await resizer.boundingBox();
  const dragStartX = box.x + 5;

  await resizer.dispatchEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: dragStartX, clientY: 100 });
  await expect(resizer).toHaveClass(/dragging/);
  await expect(mdv.page.locator('body')).toHaveClass(/resizing/);

  await resizer.dispatchEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, clientX: dragStartX + 50, clientY: 100 });
  expect((await mdv.state()).S.sidebarWidth).toBe(350);   // 300 + 50px delta

  await resizer.dispatchEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, clientX: dragStartX + 50, clientY: 100 });
  await expect(resizer).not.toHaveClass(/dragging/);
  await expect(mdv.page.locator('body')).not.toHaveClass(/resizing/);

  await mdv.call('applySidebarWidth', 300);
  await resizer.dispatchEvent('dblclick', { bubbles: true });
  const { S, DEFAULTS } = await mdv.state();
  expect(S.sidebarWidth).toBe(DEFAULTS.sidebarWidth);
});
