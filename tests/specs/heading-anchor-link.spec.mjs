// "Copy link to heading" (docs/BACKLOG.md's Features #3): the '#' anchor
// prepended to every heading now carries a real file:// URI (path + heading
// id) as its href, instead of just "#id" -- WebView2's context menu already
// keeps "Copy link location" (main.cpp), so right-clicking it copies
// something portable. A left-click must still just scroll in place, exactly
// as before -- the href changing shape must not turn a click into an actual
// (and useless, inside this app) navigation attempt.

import { test, expect } from '../harness/fixtures.mjs';

test('a heading anchor carries a real file:// URI for a document on disk', async ({ mdv }) => {
  await mdv.openDoc('# First\n\nBody one.\n\n## Second\n\nBody two.\n', {
    name: 'notes.md', dir: 'C:\\Users\\x\\docs',
  });

  const anchors = mdv.page.locator('#content a.hanchor');
  await expect(anchors).toHaveCount(2);
  const hrefs = await anchors.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(hrefs[0]).toBe('file:///C:/Users/x/docs/notes.md#first');
  expect(hrefs[1]).toBe('file:///C:/Users/x/docs/notes.md#second');
});

test('clicking a heading anchor scrolls in place rather than following the href', async ({ mdv }) => {
  const filler = Array.from({ length: 60 }, (_, i) => `Line ${i}.`).join('\n\n');
  // Not "Target": DOMPurify's DOM-clobbering guard (SANITIZE_NAMED_PROPS)
  // strips id="target" specifically (a known dangerous id/name value, e.g.
  // via window.target / anchor-target hijacking), which would leave that
  // heading anchor-less through no fault of this feature -- picked this one
  // apart the hard way once already.
  await mdv.openDoc(`# Top\n\n${filler}\n\n## Bottom Section\n\n${filler}\n`, { name: 'scroll.md' });

  await mdv.page.locator('#content a.hanchor').nth(1).click();
  // scrollToId() (app.js) focuses the TARGET HEADING itself, not the anchor
  // that was clicked -- a decisive signal that gotoHash() actually ran,
  // unlike scrollTop alone (Playwright's own pre-click actionability check
  // already scrolls the clicked element into view, which -- being nested
  // inside this exact heading -- would satisfy a bare "did it scroll"
  // assertion whether or not this feature's own click handling ever fired).
  await mdv.page.waitForFunction(() => document.activeElement && document.activeElement.id === 'bottom-section');
});

test('a document with no real path (e.g. a brand-new untitled doc) falls back to a plain fragment href', async ({ mdv }) => {
  await mdv.call('renderDocument', '# Untitled heading\n',
    { kind: 'file', name: 'Untitled', path: '', dir: '', plain: '0', nav: 'new' });
  await mdv.waitForDebugLog('renderComplete');

  const href = await mdv.page.locator('#content a.hanchor').first().getAttribute('href');
  expect(href).toBe('#untitled-heading');
});
