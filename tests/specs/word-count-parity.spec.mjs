// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- the status
// bar's word count disagreed between read mode (countVisibleWords(),
// counting the fully RENDERED text) and edit mode (countWordsInSource(), a
// cheap source-based count) by ~16% on an ordinarily-formatted document
// (measured before the fix: 37 raw vs 32 rendered words for a heading +
// list + blockquote + a plain paragraph) -- a real, confusing inconsistency
// between two counts shown for the SAME #sb-pct tooltip on the SAME
// document, not just estimate noise. countWordsInSource() strips leading
// block markers per line to close the gap. This exercises both real
// production surfaces end-to-end (open, read the tooltip; edit, read it
// again) rather than calling the internal helpers directly.

import { test, expect } from '../harness/fixtures.mjs';

test('the status-bar word count matches between read mode and edit mode', async ({ mdv }) => {
  const sampleDoc = '# My Document\n\n- First item here\n- Second item\n- Third one too\n\n' +
    '> A blockquote with some words in it\n\nSome regular paragraph text with **bold** and *italic* words in it, plus a [link](url) too.\n';
  await mdv.openDoc(sampleDoc, { name: 'wordcount-parity.md' });

  const renderedTitle = await mdv.page.locator('#sb-pct').getAttribute('title');
  const renderedCount = parseInt(renderedTitle, 10);
  expect(Number.isFinite(renderedCount)).toBe(true);

  await mdv.call('enterEdit');
  await mdv.call('refreshEditorViews');
  // refreshEditorViews() debounces its own update by 200ms (see its comment
  // in app.js) -- waiting for the tooltip text to CHANGE would time out
  // whenever this test is passing (read/edit counts equal -> identical
  // tooltip text), so a plain wait past the debounce is the correct check
  // here, not a "did it change" poll.
  await mdv.page.waitForTimeout(300);
  const sourceTitle = await mdv.page.locator('#sb-pct').getAttribute('title');
  const sourceCount = parseInt(sourceTitle, 10);

  // Block markers (1 heading, 3 list bullets, 1 blockquote) account for the
  // whole gap in this sample, so stripping them closes it completely, not
  // just narrows it.
  expect(sourceCount).toBe(renderedCount);
});
