// The editor's spellcheck was hardcoded off (index.html's spellcheck="false")
// with no way to turn it on. docs/BACKLOG.md's Features #8: a new Aa-panel
// checkbox drives the editor's real spellcheck DOM property.

import { test, expect } from '../harness/fixtures.mjs';

test('the spellcheck toggle actually flips the editor\'s spellcheck property', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nSome text.\n', { name: 'spell.md' });
  await mdv.call('enterEdit');

  expect(await mdv.page.evaluate(() => document.getElementById('editor').spellcheck)).toBe(false);

  await mdv.page.evaluate(() => {
    const el = document.getElementById('set-spellcheck');
    el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  expect(await mdv.page.evaluate(() => document.getElementById('editor').spellcheck)).toBe(true);
});
