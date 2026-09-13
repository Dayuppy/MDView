// Lightbox next/previous (docs/BACKLOG.md's Features #11): stepping through
// a document's images without closing and reopening the lightbox for each
// one, via new prev/next buttons and Left/Right arrow keys.

import { test, expect } from '../harness/fixtures.mjs';

const DOC = '# Doc\n\n![one](one.png)\n\nSome text.\n\n![two](two.png)\n\n![three](three.png)\n';

test('prev/next buttons and arrow keys step through the document\'s images', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'gallery.md' });

  await mdv.page.locator('#content img').nth(0).click();
  await expect(mdv.page.locator('#lightbox')).toBeVisible();
  await expect(mdv.page.locator('#lightbox-img')).toHaveAttribute('alt', 'one');
  await expect(mdv.page.locator('#lightbox-prev')).toBeDisabled();
  await expect(mdv.page.locator('#lightbox-next')).toBeEnabled();

  await mdv.page.locator('#lightbox-next').click();
  await expect(mdv.page.locator('#lightbox-img')).toHaveAttribute('alt', 'two');
  await expect(mdv.page.locator('#lightbox-prev')).toBeEnabled();
  await expect(mdv.page.locator('#lightbox-next')).toBeEnabled();

  // Arrow keys, not just the buttons.
  await mdv.page.keyboard.press('ArrowRight');
  await expect(mdv.page.locator('#lightbox-img')).toHaveAttribute('alt', 'three');
  await expect(mdv.page.locator('#lightbox-next')).toBeDisabled();

  // Focus must still be somewhere INSIDE the modal at this point -- the
  // just-disabled #lightbox-next was also the just-clicked, currently-
  // focused element a moment ago, and a disabled element can't hold focus
  // (a real, if obscure, browser quirk: it blurs straight out to <body>).
  // Losing focus here would break every subsequent keyboard interaction,
  // arrow keys included -- covered directly, not just inferred from the
  // arrow-key checks around it still passing.
  const activeInModal = await mdv.page.evaluate(() =>
    document.getElementById('lightbox').contains(document.activeElement));
  expect(activeInModal).toBe(true);

  // The Tab-trap's own "wrap past the last focusable control" logic must
  // still work with next AND zoom-out/zoom-reset disabled at this boundary
  // too (next: no image after this one; zoom-out/reset: not zoomed in) --
  // Tab from #lightbox-zoom-in (now the last ENABLED control) should wrap
  // back to #lightbox-close, not escape the trap.
  await mdv.page.locator('#lightbox-zoom-in').focus();
  await mdv.page.keyboard.press('Tab');
  await expect(mdv.page.locator('#lightbox-close')).toBeFocused();

  await mdv.page.keyboard.press('ArrowLeft');
  await expect(mdv.page.locator('#lightbox-img')).toHaveAttribute('alt', 'two');

  // Still a real modal -- Escape still closes it, unaffected by the new keys.
  await mdv.page.keyboard.press('Escape');
  await expect(mdv.page.locator('#lightbox')).toBeHidden();
});
