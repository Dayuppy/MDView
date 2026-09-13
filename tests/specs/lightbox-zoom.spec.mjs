// Lightbox zoom/pan (docs/BACKLOG.md's Features #11, the remaining half
// after next/prev). Zoom via wheel, the +/- buttons, +/-/0 keys, and a
// click on the image itself (toggles 1x <-> 2x, distinguished from a
// drag-to-pan gesture by whether the pointer actually moved). Resets on
// every image change and on close.

import { test, expect } from '../harness/fixtures.mjs';

function getTransform(mdv) {
  return mdv.page.locator('#lightbox-img').evaluate((img) => img.style.transform);
}

test('the +/- buttons zoom in and out, and reset returns to 1x', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\n![pic](pic.png)\n', { name: 'zoom.md' });
  await mdv.page.locator('#content img').click();
  await expect(mdv.page.locator('#lightbox')).toBeVisible();

  await expect(mdv.page.locator('#lightbox-zoom-out')).toBeDisabled();
  await expect(mdv.page.locator('#lightbox-zoom-reset')).toBeDisabled();

  await mdv.page.locator('#lightbox-zoom-in').click();
  await expect.poll(() => getTransform(mdv)).toContain('scale(1.5)');
  await expect(mdv.page.locator('#lightbox-zoom-out')).toBeEnabled();
  await expect(mdv.page.locator('#lightbox-zoom-reset')).toBeEnabled();

  await mdv.page.locator('#lightbox-zoom-reset').click();
  const t = await getTransform(mdv);
  expect(t === '' || t === 'none').toBe(true);
  await expect(mdv.page.locator('#lightbox-zoom-out')).toBeDisabled();
});

test('+/-/0 keys zoom the same way the buttons do', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\n![pic](pic.png)\n', { name: 'zoomkeys.md' });
  await mdv.page.locator('#content img').click();

  await mdv.page.keyboard.press('+');
  await expect.poll(() => getTransform(mdv)).toContain('scale(1.5)');
  await mdv.page.keyboard.press('+');
  await expect.poll(() => getTransform(mdv)).toContain('scale(2)');
  await mdv.page.keyboard.press('-');
  await expect.poll(() => getTransform(mdv)).toContain('scale(1.5)');
  await mdv.page.keyboard.press('0');
  const t = await getTransform(mdv);
  expect(t === '' || t === 'none').toBe(true);
});

test('zoom is clamped to the max, and cannot go below 1x', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\n![pic](pic.png)\n', { name: 'zoomclamp.md' });
  await mdv.page.locator('#content img').click();

  for (let i = 0; i < 10; i++) await mdv.page.keyboard.press('+');
  await expect.poll(() => getTransform(mdv)).toContain('scale(4)');
  await expect(mdv.page.locator('#lightbox-zoom-in')).toBeDisabled();

  await mdv.page.keyboard.press('0');
  await mdv.page.keyboard.press('-');   // already at 1x -- must not go negative
  const t = await getTransform(mdv);
  expect(t === '' || t === 'none').toBe(true);
});

test('a plain click on the image toggles zoom (1x <-> 2x)', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\n![pic](pic.png)\n', { name: 'zoomclick.md' });
  await mdv.page.locator('#content img').click();

  await mdv.page.locator('#lightbox-img').click();
  await expect.poll(() => getTransform(mdv)).toContain('scale(2)');

  await mdv.page.locator('#lightbox-img').click();
  const t = await getTransform(mdv);
  expect(t === '' || t === 'none').toBe(true);
});

test('clicking the image no longer closes the lightbox (it is the zoom surface now)', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\n![pic](pic.png)\n', { name: 'zoomnoclose.md' });
  await mdv.page.locator('#content img').click();
  await mdv.page.locator('#lightbox-img').click();
  await expect(mdv.page.locator('#lightbox')).toBeVisible();
  // The backdrop itself still closes it.
  await mdv.page.locator('#lightbox').click({ position: { x: 5, y: 5 } });
  await expect(mdv.page.locator('#lightbox')).toBeHidden();
});

test('zoom resets when stepping to a different image, and on close', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\n![one](one.png)\n\n![two](two.png)\n', { name: 'zoomreset.md' });
  await mdv.page.locator('#content img').first().click();
  await mdv.page.locator('#lightbox-zoom-in').click();
  await expect.poll(() => getTransform(mdv)).toContain('scale(1.5)');

  await mdv.page.locator('#lightbox-next').click();
  const t1 = await getTransform(mdv);
  expect(t1 === '' || t1 === 'none').toBe(true);

  await mdv.page.locator('#lightbox-zoom-in').click();
  await expect.poll(() => getTransform(mdv)).toContain('scale(1.5)');
  await mdv.page.keyboard.press('Escape');
  await expect(mdv.page.locator('#lightbox')).toBeHidden();

  await mdv.page.locator('#content img').first().click();
  const t2 = await getTransform(mdv);
  expect(t2 === '' || t2 === 'none').toBe(true);
});

// Direct in-page PointerEvent dispatch (mirroring the sidebar-resizer's own
// in-page pointer-drag test) rather than Playwright's OS-level page.mouse --
// setPointerCapture() doesn't need a "real" pointer to succeed in Chromium,
// and dispatchEvent() delivers straight to this element's own listeners
// regardless of hit-testing, sidestepping any viewport-coordinate clamping
// real synthesized OS input might otherwise be subject to.
function dragLightboxImg(mdv, dx, dy) {
  return mdv.page.evaluate(({ dx, dy }) => {
    const img = document.getElementById('lightbox-img');
    const r = img.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    img.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: cx, clientY: cy }));
    img.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, clientX: cx + dx, clientY: cy + dy }));
    img.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, clientX: cx + dx, clientY: cy + dy }));
  }, { dx, dy });
}

test('dragging a zoomed image pans it, clamped so it cannot be dragged fully off-screen', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\n![pic](pic.png)\n', { name: 'zoompan.md' });
  await mdv.page.locator('#content img').click();
  await mdv.page.locator('#lightbox-zoom-in').click();
  await mdv.page.locator('#lightbox-zoom-in').click();
  await expect.poll(() => getTransform(mdv)).toContain('scale(2)');

  // A modest drag pans by roughly the drag distance.
  await dragLightboxImg(mdv, 40, 20);
  let t = await getTransform(mdv);
  expect(t).toMatch(/translate\(/);
  // A drag must not also toggle the zoom level the way a plain click does.
  expect(t).toContain('scale(2)');
  let [, panX] = t.match(/translate\(([-\d.]+)px/);
  expect(Number(panX)).toBeGreaterThan(5);
  expect(Number(panX)).toBeLessThan(60);

  // A wildly excessive drag must be CLAMPED, not applied verbatim -- the
  // real claim this test makes. 2000px of raw movement at 2x zoom on a
  // small test image would blow past any sane bound if clampLightboxPan()
  // weren't doing its job.
  await dragLightboxImg(mdv, 2000, 0);
  t = await getTransform(mdv);
  [, panX] = t.match(/translate\(([-\d.]+)px/);
  expect(Number(panX)).toBeLessThan(500);

  // Still a real modal, focus-trap and all -- confirms the drag gesture
  // didn't leave anything in a broken state.
  await expect(mdv.page.locator('#lightbox')).toBeVisible();
});
