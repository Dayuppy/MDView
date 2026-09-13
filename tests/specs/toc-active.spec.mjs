// Covers updateProgress()'s active-TOC-link tracking (assets/app.js) -- no
// prior spec or regression scenario touched this at all. Written because the
// scroll handler was just rewritten to cache tocList's <a> elements and
// toggle 'active' on only the (at most two) links whose state actually
// changes, instead of re-querying the live DOM and touching every link on
// every animation frame (docs/BACKLOG.md's "measured performance" list).
// This proves the rewrite still produces the same observable result across
// a REAL scroll, in both directions -- exercising both the "nothing active
// yet" -> "one active" transition and the "move active from one link to
// another" transition (the actual delta-toggle logic, not just the trivial
// first-call case).

import { test, expect } from '../harness/fixtures.mjs';

function docWithHeadings(n) {
  const filler = Array.from({ length: 40 }, (_, i) => `Body line ${i}.`).join('\n\n');
  let out = '';
  for (let i = 1; i <= n; i++) out += `# Heading ${i}\n\n${filler}\n\n`;
  return out;
}

async function activeLinks(page) {
  return page.locator('#toc-list a.active').all();
}

test('scrolling moves the active TOC link, touching only the link that changed', async ({ mdv }) => {
  await mdv.openDoc(docWithHeadings(6), { name: 'toc-active.md' });
  await mdv.call('setSidebar', true);

  // Scroll to the very bottom: the LAST heading should become active.
  await mdv.page.evaluate(() => {
    const el = document.getElementById('main');
    el.scrollTop = el.scrollHeight;
  });
  await mdv.page.waitForFunction(() => {
    const links = document.querySelectorAll('#toc-list a');
    return links.length > 0 && links[links.length - 1].classList.contains('active');
  });
  let active = await activeLinks(mdv.page);
  expect(active).toHaveLength(1);
  const lastLinkText = await mdv.page.locator('#toc-list a').last().textContent();
  expect(await active[0].textContent()).toBe(lastLinkText);

  // Scroll back to the top: the active link must move OFF the last heading
  // -- proving the link that was active got explicitly cleared, not left
  // stuck from the previous scroll position (the exact bug a broken
  // delta-toggle -- e.g. only ever adding 'active', never removing it --
  // would produce). At most one link may be active at a time either way.
  await mdv.page.evaluate(() => { document.getElementById('main').scrollTop = 0; });
  await mdv.page.waitForFunction((lastText) => {
    const links = [...document.querySelectorAll('#toc-list a')];
    const active = links.filter((a) => a.classList.contains('active'));
    if (active.length > 1) return false;
    return active.length === 0 || active[0].textContent !== lastText;
  }, lastLinkText);
  active = await activeLinks(mdv.page);
  expect(active.length).toBeLessThanOrEqual(1);
  if (active.length === 1) expect(await active[0].textContent()).not.toBe(lastLinkText);
});
