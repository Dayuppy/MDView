// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- the base
// case-sensitivity behavior of runSearch()/findStep(), independent of the
// whole-word/regex/phrase modes already covered by find-options.spec.mjs.

import { test, expect } from '../harness/fixtures.mjs';

test('case-insensitive search finds every occurrence regardless of case', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\none Fox two fox three FOX four\n', { name: 'case.md' });
  await mdv.call('runSearch', 'fox');
  const { matches } = await mdv.state();
  expect(matches.length).toBe(3);
});

test('case-sensitive search (findCase on) finds only the exact-case match', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\none Fox two fox three FOX four\n', { name: 'case-sensitive.md' });
  await mdv.page.locator('#btn-find').click();
  await mdv.page.locator('#find-case').click();
  await mdv.call('runSearch', 'fox');
  const { matches } = await mdv.state();
  expect(matches.length).toBe(1);
});

test('findStep on a single match stays on it rather than losing the selection', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\none Fox two fox three FOX four\n', { name: 'single.md' });
  await mdv.page.locator('#btn-find').click();
  await mdv.page.locator('#find-case').click();
  await mdv.call('runSearch', 'fox');
  await mdv.call('findStep', 1);
  const { matches, matchIdx } = await mdv.state();
  expect(matches.length).toBe(1);
  expect(matchIdx).toBe(0);
});
