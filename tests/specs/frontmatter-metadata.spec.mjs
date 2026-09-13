// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- buildFrontMatter()'s
// metadata table, a deliberately simple line-based parser (not full YAML),
// but "key: value" and an indented "- item" list under a key are its two
// explicitly-designed cases. Exercised end-to-end through a real document
// (buildFrontMatter isn't itself exposed on __MDV_TEST -- it's only ever
// called from inside renderDocument(), so a real open is the natural way in
// rather than adding a hook for a single-use internal helper).

import { test, expect } from '../harness/fixtures.mjs';

test('a simple key/value front-matter line becomes its own metadata row', async ({ mdv }) => {
  await mdv.openDoc('---\ntitle: Test Doc\n---\n\nBody.\n', { name: 'fm-kv.md' });
  const rows = mdv.page.locator('.frontmatter table tbody tr');
  await expect(rows.first().locator('td').nth(0)).toHaveText('title');
  await expect(rows.first().locator('td').nth(1)).toHaveText('Test Doc');
});

test('an indented "- item" list joins into its key\'s row, comma-separated', async ({ mdv }) => {
  await mdv.openDoc('---\ntags:\n  - alpha\n  - beta\n---\n\nBody.\n', { name: 'fm-list.md' });
  const row = mdv.page.locator('.frontmatter table tbody tr').first();
  await expect(row.locator('td').nth(0)).toHaveText('tags');
  await expect(row.locator('td').nth(1)).toHaveText('alpha, beta');
});
