// The Aa reading-settings panel's letter spacing never reached the editor
// (#editor's CSS only consumed --content-size/--content-lh, never
// --content-ls) -- docs/BACKLOG.md's Features #5. A dyslexia-friendly
// letter-spacing choice is exactly the kind of accessibility accommodation
// a reader wants everywhere they read their own text, editing included.

import { test, expect } from '../harness/fixtures.mjs';

test('a letter-spacing preference reaches the editor, not just the reading view', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nSome text.\n', { name: 'typo.md' });

  const before = await mdv.page.evaluate(() =>
    getComputedStyle(document.getElementById('editor')).letterSpacing);

  await mdv.page.evaluate(() => {
    const el = document.getElementById('set-ls');
    el.value = '0.1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await mdv.call('enterEdit');
  const after = await mdv.page.evaluate(() =>
    getComputedStyle(document.getElementById('editor')).letterSpacing);

  expect(after).not.toBe(before);
  expect(parseFloat(after)).toBeGreaterThan(0);
});
