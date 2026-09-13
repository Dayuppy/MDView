// updateDocStats() (status-bar tooltip) and documentStats() (F1 panel) both
// counted #content's ENTIRE textContent, including text the reader never
// actually sees: a code block's language label and "Copy"/"Copied ✓"
// button (decorate()'s .codebar) and KaTeX's visually-hidden MathML/TeX
// source duplicate of every formula. docs/BACKLOG.md's Features #7.

import { test, expect } from '../harness/fixtures.mjs';

test('a code block\'s language label and Copy button are not counted as words', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\none two three\n\n```javascript\nfour five\n```\n', { name: 'code.md' });

  // #content really does contain "javascript" and "Copy" as visible-but-
  // excluded text -- confirms the fix is actually filtering something real,
  // not just trivially passing because the text isn't there at all.
  await expect(mdv.page.locator('#content .codelang')).toHaveText('javascript');
  await expect(mdv.page.locator('#content .copybtn')).toHaveText('Copy');

  const words = await mdv.page.locator('#sb-pct').getAttribute('title');
  // "Doc one two three four five" -- 6 real words. Neither "javascript" nor
  // "Copy" (nor the heading anchor's own "#") may appear in the count.
  expect(words).toMatch(/^6 words/);
});
