// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- confirmDiscard()
// gates the feature-tour ("demo") menu action and F5/reload-while-dirty.
// Calls confirmDiscard() directly (already exposed on __MDV_TEST) rather
// than clicking through to "Feature tour", which would call the real
// loadDemo() and replace the document the rest of a test run might depend
// on. window.confirm is a REAL native dialog when dirty=true -- handled
// through Playwright's page.on('dialog') API rather than monkey-patching
// window.confirm, since this is a real browser context.

import { test, expect } from '../harness/fixtures.mjs';

test('confirmDiscard returns true without prompting when nothing is unsaved', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'discard-clean.md' });
  await mdv.call('setDirty', false);

  let dialogFired = false;
  mdv.page.on('dialog', (d) => { dialogFired = true; d.dismiss(); });

  const result = await mdv.call('confirmDiscard', 'do the thing');
  expect(result).toBe(true);
  expect(dialogFired).toBe(false);
});

test('confirmDiscard prompts and honors "cancel" when there are unsaved changes', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'discard-cancel.md' });
  await mdv.call('setDirty', true);

  let dialogMessage = null;
  mdv.page.on('dialog', (d) => { dialogMessage = d.message(); d.dismiss(); });

  const result = await mdv.call('confirmDiscard', 'do the thing');
  expect(result).toBe(false);
  expect(dialogMessage).toContain('do the thing');
});

test('confirmDiscard prompts and honors "OK" when there are unsaved changes', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'discard-accept.md' });
  await mdv.call('setDirty', true);

  let dialogMessage = null;
  mdv.page.on('dialog', (d) => { dialogMessage = d.message(); d.accept(); });

  const result = await mdv.call('confirmDiscard', 'do the thing');
  expect(result).toBe(true);
  expect(dialogMessage).toContain('do the thing');
});
