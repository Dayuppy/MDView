// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- showDiagramError()
// strips role/aria-label so a failed diagram's fallback text isn't hidden
// from screen readers (role="img" makes all descendants presentational),
// but a theme change resets already-rendered diagrams back to .pending and
// retries them (applyPrefs()) -- a diagram that failed once and later
// succeeds needs those re-stamped, not left permanently missing. There's no
// naturally-reachable way to make a syntactically valid diagram fail on its
// real first attempt, so this drives showDiagramError()/renderMermaids()
// directly (both exposed on __MDV_TEST for this reason) rather than via a
// contrived end-to-end setup.

import { test, expect } from '../harness/fixtures.mjs';

test('mermaid role/aria-label are restored after a fail-then-succeed cycle', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\n```mermaid\ngraph TD; A-->B;\n```\n', { name: 'mermaid-recover.md' });
  await mdv.page.waitForFunction(() => document.querySelector('.mermaid-fig svg'));

  const result = await mdv.page.evaluate(() => {
    const fig = document.querySelector('.mermaid-fig');
    const src = fig.dataset.src;
    window.__MDV_TEST.showDiagramError(fig, src, 'simulated prior failure');
    fig.classList.add('pending');
    fig.classList.remove('diagram-error');
    return window.__MDV_TEST.renderMermaids().then(() => ({
      role: fig.getAttribute('role'),
      ariaLabel: fig.getAttribute('aria-label'),
    }));
  });

  expect(result.role).toBe('img');
  expect(result.ariaLabel).toMatch(/^Diagram:/);
});
