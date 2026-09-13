// Outline collapse (docs/BACKLOG.md's Features #11, the last open piece).
// A heading with at least one deeper heading immediately after it (before
// the next same-or-shallower one) gets a toggle button; collapsing hides
// that whole run of deeper <li>s in place (no rebuild), computed from the
// flat, already-ordered list -- no tree structure needed.

import { test, expect } from '../harness/fixtures.mjs';

const DOC = '# A\n\nBody.\n\n## A1\n\nBody.\n\n### A1a\n\nBody.\n\n## A2\n\nBody.\n\n# B\n\nBody.\n\n## B1\n\nBody.\n';

test('a heading with children gets an enabled toggle; a leaf heading does not', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'collapse.md' });
  await mdv.call('setSidebar', true);

  const toggles = mdv.page.locator('#toc-list .toc-toggle');
  await expect(toggles).toHaveCount(6);
  // A(0) A1(1) A1a(2) A2(3) B(4) B1(5) -- A, A1, and B have a deeper heading
  // immediately after them; A1a, A2, and B1 don't.
  await expect(toggles.nth(0)).toBeEnabled();
  await expect(toggles.nth(1)).toBeEnabled();
  await expect(toggles.nth(2)).toBeDisabled();
  await expect(toggles.nth(3)).toBeDisabled();
  await expect(toggles.nth(4)).toBeEnabled();
  await expect(toggles.nth(5)).toBeDisabled();
});

test('collapsing a heading hides its whole run of deeper headings, not siblings past it', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'collapse2.md' });
  await mdv.call('setSidebar', true);

  const items = mdv.page.locator('#toc-list li');
  await expect(items).toHaveCount(6);

  await mdv.page.locator('#toc-list .toc-toggle').nth(0).click();   // collapse A
  await expect(items.nth(0)).toBeVisible();     // A itself stays
  await expect(items.nth(1)).toBeHidden();      // A1
  await expect(items.nth(2)).toBeHidden();      // A1a
  await expect(items.nth(3)).toBeHidden();      // A2 -- still A's child (level 2 > A's level 1)
  await expect(items.nth(4)).toBeVisible();     // B -- level 1, not under A
  await expect(items.nth(5)).toBeVisible();     // B1 -- shown since B isn't collapsed

  // Expanding restores everything.
  await mdv.page.locator('#toc-list .toc-toggle').nth(0).click();
  for (let i = 0; i < 6; i++) await expect(items.nth(i)).toBeVisible();
});

test('collapsing a nested heading only hides its own narrower run', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'collapse3.md' });
  await mdv.call('setSidebar', true);
  const items = mdv.page.locator('#toc-list li');

  await mdv.page.locator('#toc-list .toc-toggle').nth(1).click();   // collapse A1 (not A)
  await expect(items.nth(0)).toBeVisible();   // A
  await expect(items.nth(1)).toBeVisible();   // A1 itself
  await expect(items.nth(2)).toBeHidden();    // A1a -- A1's child
  await expect(items.nth(3)).toBeVisible();   // A2 -- a sibling of A1, not under it
});

test('a filter query reveals matches even under a collapsed heading', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'collapse4.md' });
  await mdv.call('setSidebar', true);
  const items = mdv.page.locator('#toc-list li');

  await mdv.page.locator('#toc-list .toc-toggle').nth(0).click();   // collapse A
  await expect(items.nth(2)).toBeHidden();   // A1a, confirmed hidden by the collapse

  await mdv.page.locator('#toc-filter').fill('a1a');
  await expect(items.nth(2)).toBeVisible();   // filtering ignores collapse
  await expect(items.nth(4)).toBeHidden();    // B doesn't match "a1a"

  // Clearing the filter restores the fold exactly as it was.
  await mdv.page.locator('#toc-filter').fill('');
  await expect(items.nth(2)).toBeHidden();
  await expect(items.nth(4)).toBeVisible();
});

test('collapse state resets when a new document loads', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'collapse5.md' });
  await mdv.call('setSidebar', true);
  await mdv.page.locator('#toc-list .toc-toggle').nth(0).click();
  await expect(mdv.page.locator('#toc-list li').nth(1)).toBeHidden();

  await mdv.openDoc('# One\n\nBody.\n\n## Two\n\nBody.\n', { name: 'collapse6.md' });
  const items2 = mdv.page.locator('#toc-list li');
  await expect(items2).toHaveCount(2);
  await expect(items2.nth(1)).toBeVisible();   // not collapsed, unaffected by the last document's state
  await expect(mdv.page.locator('#toc-list .toc-toggle').nth(0)).toHaveAttribute('aria-expanded', 'true');
});
