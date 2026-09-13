// enterEdit() (Ctrl+E) always landed the caret at position 0 regardless of
// where the reader was scrolled to -- docs/BACKLOG.md's Features #4. Now it
// captures currentHeadingIndex() (read-mode scroll position) BEFORE
// switching modes and maps it through sourceHeadings() to a real source
// offset.

import { test, expect } from '../harness/fixtures.mjs';

function docWithHeadings(n) {
  const filler = Array.from({ length: 40 }, (_, i) => `Body line ${i}.`).join('\n\n');
  let out = '';
  for (let i = 1; i <= n; i++) out += `# Section ${i}\n\n${filler}\n\n`;
  return out;
}

test('Ctrl+E lands the caret at the section that was on screen, not always line 1', async ({ mdv }) => {
  const text = docWithHeadings(6);
  await mdv.openDoc(text, { name: 'sync.md' });

  await mdv.page.evaluate(() => {
    const el = document.getElementById('main');
    el.scrollTop = el.scrollHeight;   // scroll to the very bottom -> last section
  });
  await mdv.page.waitForFunction(() => {
    const links = document.querySelectorAll('#toc-list a');
    return links.length > 0 && links[links.length - 1].classList.contains('active');
  });

  await mdv.call('enterEdit');

  const selectionStart = await mdv.page.evaluate(() => window.__MDV_TEST.els.editor.selectionStart);
  const expectedIndex = text.lastIndexOf('# Section 6');
  expect(selectionStart).toBe(expectedIndex);
});

test('scrolled to the very top, Ctrl+E still lands at the start (existing behavior preserved)', async ({ mdv }) => {
  const text = docWithHeadings(3);
  await mdv.openDoc(text, { name: 'sync-top.md' });

  await mdv.call('enterEdit');

  const selectionStart = await mdv.page.evaluate(() => window.__MDV_TEST.els.editor.selectionStart);
  expect(selectionStart).toBe(0);
});
