// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- decorate()'s
// own top comment explains that DOMPurify allows data-* attributes by
// default, so hand-authored inline HTML in an untrusted document (raw HTML
// passes straight through -- html:true) could forge a data-open attribute a
// real markdown link's href-resolution would never have produced -- e.g. a
// UNC path, bypassing openPath's href-based resolution loop entirely.
// decorate() strips data-open/data-hash from every <a> FIRST, before its own
// loop re-sets it correctly for genuine links. Verified through the real
// render -> sanitize -> decorate pipeline (a genuine document, opened
// end-to-end, whose body is the hand-authored HTML) rather than calling
// decorate() on a hand-built fragment via PURIFY_CFG_FRAGMENT directly --
// more end-to-end, and no harder to set up than the fragment route.

import { test, expect } from '../harness/fixtures.mjs';

test('a hand-authored data-open/data-hash attribute is stripped, while a genuine markdown link still gets data-open set', async ({ mdv }) => {
  await mdv.openDoc(
    '<a data-open="\\\\evil-host\\share\\x.md" data-hash="fake">click</a>\n\n' +
    '[local link](sibling.md)\n',
    { name: 'decorate-data-open.md' },
  );

  const result = await mdv.page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('#content a'));
    const attack = anchors[0];
    const real = anchors[1];
    return {
      attackOpen: attack ? attack.dataset.open ?? null : undefined,
      attackHash: attack ? attack.dataset.hash ?? null : undefined,
      realOpen: real ? real.dataset.open ?? null : undefined,
    };
  });

  // The forged attribute (no real href behind it) is stripped, not trusted.
  expect(result.attackOpen).toBeNull();
  expect(result.attackHash).toBeNull();
  // The strip isn't a blanket no-op -- a genuine markdown link still
  // correctly gets data-open set by decorate()'s own href-resolution loop.
  expect(result.realOpen).toMatch(/sibling\.md$/i);
});
