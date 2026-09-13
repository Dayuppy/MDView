// Outline filter (docs/BACKLOG.md's Features #11): a text box above the
// section list narrows it to matching headings, without rebuilding the
// list (so scroll-driven active-link tracking keeps working on the exact
// same elements underneath).

import { test, expect } from '../harness/fixtures.mjs';

const DOC = '# Intro\n\nBody.\n\n# Setup Guide\n\nBody.\n\n# Advanced Setup\n\nBody.\n\n# FAQ\n\nBody.\n';

test('typing in the filter box narrows the section list to matching headings', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'toc.md' });
  await mdv.call('setSidebar', true);

  const items = mdv.page.locator('#toc-list li');
  await expect(items).toHaveCount(4);

  await mdv.page.locator('#toc-filter').fill('setup');
  await expect(items).toHaveCount(4);   // still 4 in the DOM, just some hidden
  await expect(mdv.page.locator('#toc-list li:visible')).toHaveCount(2);
  await expect(mdv.page.locator('#toc-list a:visible')).toContainText(['Setup Guide', 'Advanced Setup']);
  await expect(mdv.page.locator('#toc-empty')).toBeHidden();

  await mdv.page.locator('#toc-filter').fill('nonexistent');
  await expect(mdv.page.locator('#toc-list li:visible')).toHaveCount(0);
  await expect(mdv.page.locator('#toc-empty')).toBeVisible();

  await mdv.page.locator('#toc-filter').fill('');
  await expect(mdv.page.locator('#toc-list li:visible')).toHaveCount(4);
  await expect(mdv.page.locator('#toc-empty')).toBeHidden();
});

test('the filter resets when a new document opens, not carried over from the last one', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'toc-a.md' });
  await mdv.call('setSidebar', true);
  await mdv.page.locator('#toc-filter').fill('setup');
  await expect(mdv.page.locator('#toc-list li:visible')).toHaveCount(2);

  await mdv.openDoc('# One\n\nBody.\n\n# Two\n\nBody.\n', { name: 'toc-b.md' });
  await expect(mdv.page.locator('#toc-filter')).toHaveValue('');
  await expect(mdv.page.locator('#toc-list li:visible')).toHaveCount(2);
});
