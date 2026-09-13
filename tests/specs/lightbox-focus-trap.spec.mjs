// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- the
// lightbox's focus trap (a general Tab-trap over every focusable
// descendant, not hardcoded to a single control). The original in-page
// test had to append a synthetic extra button since the lightbox only had
// one real focusable control at the time; it now has six (close/prev/
// next/zoom-out/zoom-reset/zoom-in -- see lightbox-zoom.spec.mjs), so this
// drives the trap with real Tab/Shift+Tab key presses over real controls
// instead.

import { test, expect } from '../harness/fixtures.mjs';

async function openLightboxOnFirstImage(mdv) {
  await mdv.openDoc(
    '# Doc\n\n![one](https://example.com/one.png)\n\n![two](https://example.com/two.png)\n',
    { name: 'lightbox-trap.md' },
  );
  await mdv.page.locator('#content img').first().click();
  await expect(mdv.page.locator('#lightbox')).toBeVisible();
}

test('opening the lightbox focuses the close button', async ({ mdv }) => {
  await openLightboxOnFirstImage(mdv);
  await expect(mdv.page.locator('#lightbox-close')).toBeFocused();
});

test('Tab from the last focusable control wraps to the first', async ({ mdv }) => {
  await openLightboxOnFirstImage(mdv);
  await mdv.page.locator('#lightbox-zoom-in').focus();
  await mdv.page.keyboard.press('Tab');
  await expect(mdv.page.locator('#lightbox-close')).toBeFocused();
});

test('Shift+Tab from the first focusable control wraps to the last', async ({ mdv }) => {
  await openLightboxOnFirstImage(mdv);
  await mdv.page.locator('#lightbox-close').focus();
  await mdv.page.keyboard.press('Shift+Tab');
  await expect(mdv.page.locator('#lightbox-zoom-in')).toBeFocused();
});

test('closing returns focus to whatever opened it', async ({ mdv }) => {
  // A real mouse click on <img> (no tabindex) blurs whatever was
  // previously focused BEFORE the click handler that calls openLightbox()
  // even runs -- standard browser behavior for a mousedown with no
  // focusable target, not something this app controls -- so there's no
  // meaningful "focused opener" to observe via a real click. Drives
  // openLightbox()/closeLightbox() directly instead (both exposed on
  // __MDV_TEST for this reason), after establishing a real, distinct
  // "opener" via a genuine .focus() call (not a click).
  await mdv.openDoc('# Doc\n\n![one](https://example.com/one.png)\n', { name: 'lightbox-trap-return.md' });
  await mdv.page.locator('#btn-menu').focus();
  await mdv.page.evaluate(() => window.__MDV_TEST.openLightbox(document.querySelector('#content img')));
  await expect(mdv.page.locator('#lightbox')).toBeVisible();

  await mdv.page.evaluate(() => window.__MDV_TEST.closeLightbox());
  await expect(mdv.page.locator('#lightbox')).toBeHidden();
  await expect(mdv.page.locator('#btn-menu')).toBeFocused();
});
