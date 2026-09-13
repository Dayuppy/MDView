// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- HTML paste ->
// Markdown conversion (Turndown) and its two escape hatches: Ctrl+Shift+V for
// a plain-text paste, and a bare URL pasted over a selection becoming a link.
// A substantial feature README describes in detail ("headings, emphasis,
// links, lists, tables and code blocks all come through as Markdown rather
// than raw tags"), driven here through real DataTransfer + a real
// ClipboardEvent('paste') dispatched at the real #editor element, in edit
// mode -- the closest headless Chromium gets to an actual OS-level clipboard
// paste, since Playwright can't deliver arbitrary clipboard content through a
// real OS paste gesture. ensureTurndown() lazily loads the vendored library
// via <script> tags; awaited directly wherever a test expects real
// conversion, so the very first paste in a fresh page doesn't race the load
// and silently no-op -- enterEdit() also calls it, but fire-and-forget
// (doesn't return the promise), so that alone isn't enough.
//
// The Ctrl+Shift+V case keeps the original's synthetic (untrusted)
// KeyboardEvent dispatch rather than a real Playwright keypress -- verified
// empirically that a real, trusted Ctrl+Shift+V on a focused editable
// element makes Chromium invoke its own native "paste without formatting"
// command, firing a second, real paste event that silently consumes
// plainPasteUntil's one-shot flag before the test's own synthetic paste
// ever runs. A synthetic/untrusted keydown never triggers that native
// command dispatch, only this app's own listener sees it -- see the test's
// own comment for the full story.

import { test, expect } from '../harness/fixtures.mjs';

/** Builds a DataTransfer from `entries` ([type, value] pairs), dispatches a
 *  real ClipboardEvent('paste') at #editor, and returns the editor's value
 *  and the event's defaultPrevented flag immediately after -- the paste
 *  handler's own work (sanitize, convert, replace selection) is entirely
 *  synchronous, so there's nothing to await beyond the dispatch itself. */
function dispatchPaste(page, entries) {
  return page.evaluate((entries) => {
    const editor = document.getElementById('editor');
    const dt = new DataTransfer();
    for (const [type, value] of entries) dt.setData(type, value);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    editor.dispatchEvent(ev);
    return { value: editor.value, defaultPrevented: ev.defaultPrevented };
  }, entries);
}

test('real clipboard HTML converts to real Markdown (heading/bold/link/list) via Turndown', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'paste-html.md' });
  await mdv.call('enterEdit');
  await mdv.call('ensureTurndown');
  await mdv.setEditor('', 0, 0);

  const html = '<h1>Hello</h1><p>This is <strong>bold</strong> and <a href="https://example.com">a link</a>.</p><ul><li>one</li><li>two</li></ul>';
  const { value } = await dispatchPaste(mdv.page, [
    ['text/html', html],
    ['text/plain', 'Hello\n\nThis is bold and a link.\n\n* one\n* two'],
  ]);

  expect(value).toMatch(/^# Hello/m);
  expect(value).toContain('**bold**');
  expect(value).toContain('[a link](https://example.com)');
  expect(value).toMatch(/^- one$/m);
  expect(value).toMatch(/^- two$/m);
});

test("Ctrl+Shift+V suppresses the HTML-to-Markdown conversion, leaving the browser's own plain-text paste to run", async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'paste-plain-gate.md' });
  await mdv.call('enterEdit');
  await mdv.setEditor('baseline text', 0, 0);

  // A synthetic (untrusted) KeyboardEvent, not a real Playwright keypress --
  // verified empirically that a REAL Ctrl+Shift+V keypress on a focused,
  // editable element makes Chromium itself invoke its own native
  // "paste without formatting" command, firing a SECOND, real paste event
  // (from whatever the OS clipboard actually holds) before the synthetic
  // dispatchPaste() below ever runs. plainPasteUntil is a one-shot flag
  // (reset the instant any paste consumes it), so that extra native paste
  // silently eats it, leaving the very paste this test cares about
  // unprotected. A synthetic/untrusted keydown never triggers the browser's
  // own native command dispatch -- only this app's own listener sees it --
  // which is exactly why the original in-page test used one.
  await mdv.page.evaluate(() => {
    document.getElementById('editor').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
  });
  const { value, defaultPrevented } = await dispatchPaste(mdv.page, [
    ['text/html', '<h2>Should not convert</h2>'],
    ['text/plain', 'Should not convert'],
  ]);

  // The actual plain-text insertion that follows is the real browser's own
  // default paste action, which a synthetic/untrusted event can't exercise
  // headlessly -- this checks the part that IS this app's own code: the gate
  // genuinely suppresses conversion and leaves the event unhandled
  // (preventDefault() never called) rather than silently eating it.
  expect(value).toBe('baseline text');
  expect(defaultPrevented).toBe(false);
});

test('a bare URL pasted over a selection becomes a real Markdown link', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'paste-url-link.md' });
  await mdv.call('enterEdit');
  await mdv.setEditor('select this text please', 7, 16); // "this text"

  const { value } = await dispatchPaste(mdv.page, [['text', 'https://example.com/page']]);

  expect(value).toBe('select [this text](https://example.com/page) please');
});

test('hostile clipboard HTML is sanitized (DOMPurify) before Turndown ever sees it', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'paste-sanitize.md' });
  await mdv.call('enterEdit');
  await mdv.call('ensureTurndown');
  await mdv.setEditor('', 0, 0);

  const { value } = await dispatchPaste(mdv.page, [
    ['text/html', '<img src=x onerror="alert(1)"><script>alert(2)</script><p>safe paragraph</p>'],
    ['text/plain', 'placeholder'],
  ]);

  expect(value).not.toMatch(/onerror/i);
  expect(value).not.toContain('alert(1)');
  expect(value).not.toMatch(/<script/i);
  expect(value).not.toContain('alert(2)');
  expect(value).toContain('safe paragraph');
});
