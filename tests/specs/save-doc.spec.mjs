// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- saveDoc()'s
// three distinct early-return branches. Calls saveDoc() directly (already
// exposed on __MDV_TEST, the same real function the Save/Save-a-copy menu
// items and Ctrl+S call) rather than driving the menu/shortcut, matching
// how this suite exercises the underlying mechanism elsewhere.

import { test, expect } from '../harness/fixtures.mjs';

test('a non-file view toasts instead of posting a save', async ({ mdv }) => {
  // The feature tour ("Feature tour" menu action) is the one real,
  // non-file document kind ('demo') -- loaded for real via a genuine menu
  // click + fetch of the real demo.md, not a synthetic doc.kind assignment.
  // demo.md has its own mermaid fence, whose FIRST-EVER render loads the
  // real vendor script (a few real seconds) -- irrelevant to this test, so
  // poll for doc.kind flipping to 'demo' directly rather than waiting on
  // the full renderComplete signal (which debugRenderComplete() defers
  // until that diagram finishes).
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'save-notfile.md' });
  await mdv.page.locator('#btn-menu').click();
  await mdv.page.locator('#menu-pop [data-act="demo"]').click();
  await mdv.page.waitForFunction(() => window.__MDV_TEST.state.doc.kind === 'demo');

  await mdv.call('saveDoc', false);
  await expect(mdv.page.locator('#toast')).toHaveText('This view has no file to save.');
});

test('a clean (non-dirty) document toasts instead of posting a save', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'save-clean.md' });
  await mdv.call('setDirty', false);

  await mdv.call('saveDoc', false);
  await expect(mdv.page.locator('#toast')).toHaveText('No changes to save.');
});

test('a dirty document posts a saveDoc message', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'save-dirty.md' });
  await mdv.call('setDirty', true);

  await mdv.call('saveDoc', false);
  expect(mdv.lastReceived('saveDoc')).toBeTruthy();
});

test('"Save a copy" posts saveAsDoc even when nothing is dirty', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'save-as.md' });
  await mdv.call('setDirty', false);

  await mdv.call('saveDoc', true);
  expect(mdv.lastReceived('saveAsDoc')).toBeTruthy();
});
