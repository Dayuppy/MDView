// A real race an ESLint require-atomic-updates pass surfaced in
// renderMermaids() (docs/BACKLOG.md): mermaidBusy was a single shared
// boolean, so a STALE, superseded document's render -- still awaiting
// ensureMermaid()/mermaid.render() when a NEWER document loads -- could
// clear it out from under the newer document's own, genuinely-still-active
// render. Worse than just "diagram stuck pending": debugRenderComplete()
// defers the renderComplete signal entirely while any .mermaid-fig.pending
// exists, so the newer document's own render never even signals done, and
// this test's openDoc() (which awaits exactly that signal) would simply
// time out. Fixed by tracking which generation owns the render lock
// (mermaidBusyGen) instead of a plain boolean, so a stale generation's
// cleanup only ever clears its own claim.

import { test, expect } from '../harness/fixtures.mjs';

test('a stale, superseded mermaid render does not block a newer document\'s own diagram from rendering', async ({ mdv }) => {
  // Warm the mermaid engine first (a real <script> load) so ensureMermaid()
  // resolves instantly for both documents below -- the race under test is
  // about the render lock, not the one-time engine load.
  await mdv.openDoc('# Warm\n\n```mermaid\ngraph TD; A-->B;\n```\n', { name: 'warm.md' });
  await mdv.page.waitForFunction(() => document.querySelector('.mermaid-fig svg'));

  // Deterministically delay the NEXT mermaid.render() call only, so
  // document A's render gets stuck mid-flight for a controlled window --
  // not a real, flaky timing race.
  await mdv.page.evaluate(() => {
    const real = window.mermaid.render.bind(window.mermaid);
    let intercepted = false;
    window.mermaid.render = (...args) => {
      if (intercepted) return real(...args);
      intercepted = true;
      return new Promise((resolve) => setTimeout(() => resolve(real(...args)), 1200));
    };
  });

  // Document A: its renderMermaids() call starts awaiting the now-delayed
  // mermaid.render() and won't resolve for ~1.2s. openDoc() only awaits the
  // TEXT render (renderComplete is deferred separately while a diagram is
  // still .pending -- see debugRenderComplete()'s own comment), so this
  // resolves quickly regardless, leaving A's diagram genuinely in flight.
  await mdv.openDoc('# Doc A\n\n```mermaid\ngraph TD; C-->D;\n```\n', { name: 'race-a.md' });

  // While A's render is still pending, document B supersedes it -- also
  // has a diagram of its own. Without the fix, B's renderMermaids() call
  // would see the shared busy flag still held (by A, not yet returned) and
  // bail out immediately, permanently leaving B's diagram stuck .pending
  // with nothing to ever retry it -- and this openDoc() call would time out
  // waiting for a renderComplete that never arrives.
  await mdv.openDoc('# Doc B\n\n```mermaid\ngraph TD; E-->F;\n```\n', { name: 'race-b.md' });

  await expect(mdv.page.locator('.mermaid-fig svg')).toBeVisible();
  await expect(mdv.page.locator('.mermaid-fig.pending')).toHaveCount(0);
});
