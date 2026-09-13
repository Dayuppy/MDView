// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- WM_DROPFILES
// arrives at the page as a native-initiated `insertImage` message (never a
// reply to anything the page sent, unlike every other FakeNative case), so
// this drives FakeNative's new `insertImage()` helper (see tests/MIGRATION.md
// / fake-native.mjs -- a test-setup helper like `loadDoc()`, since there's no
// HandleWebMessage case to mirror) instead of a page-side
// `bridge.dispatchEvent(...)` stub. That helper goes through `_post()` like
// every other outbound message, so FakeNative's `onOutbound` hook delivers it
// as a genuine MessageEvent straight into the SAME real
// `bridge.addEventListener('message', ...)` listener app.js registers in
// production (assets/app.js ~4456) -- not a reimplementation of its logic.
//
// The original's last two checks (markdown-it's own render round-trip, then
// decorate()'s doc.local resolution) are collapsed into one real end-to-end
// assertion here: leaving the editor after the drop drives the actual
// renderMarkdownInto() -> DOMPurify.sanitize() -> decorate() pipeline
// (assets/app.js's real leaveEdit() -> renderDocument() path, the same one
// tests/specs/document-info.spec.mjs already exercises this way) and reads
// the resulting REAL <img src> in #content, rather than hand-building a
// fragment and calling decorate()/PURIFY_CFG_FRAGMENT directly on it -- if
// either step mishandled the space/paren path, this one check already fails,
// and it's no less simple than the original two-step version. A third check
// (a created:true image DOES show a toast) is new -- the original in-page
// test only asserted the plain-drop "no toast" half of this contrast; the
// "should" half was previously only reachable via the real-file-write round
// trip in the section below, which stays native-only (see
// tests/MIGRATION.md's "insertImage/saveClipboardImage" note) since it needs
// a genuine saveClipboardImage file write. insertImage's own toast branch has
// zero dependency on how the file got written, though, so it's fully
// coverable here too.

import { test, expect } from '../harness/fixtures.mjs';

const dropPath = 'C:/Users/Test (User)/My Photo.png';

test.beforeEach(async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nbefore \n', { name: 'insert-image-drop.md' });
  await mdv.call('enterEdit');
  // Known editor value + caret, independent of enterEdit()'s own
  // heading-based caret placement -- matches the original in-page test's
  // 'before ' + caret-at-7 setup exactly.
  await mdv.setEditor('before ', 7, 7);
  // Known starting state, so the "no toast" check below can't pass on a
  // stale toast left over from something else.
  await mdv.page.evaluate(() => { window.__MDV_TEST.els.toastEl.hidden = true; });
});

test('a real drop wraps the path in <> and inserts it at the caret, with no toast', async ({ mdv }) => {
  mdv.native.insertImage(dropPath);   // created defaults to false -- a plain drop, nothing new written

  await expect(mdv.page.locator('#editor')).toHaveValue('before ![alt text](<' + dropPath + '>)');
  // A drop only references a file that already existed -- unlike a
  // freshly-written paste (contrast the next test), this should stay a
  // quiet aria-live announcement, not a visible toast.
  await expect(mdv.page.locator('#toast')).toBeHidden();
});

test('a created (freshly written) image shows a toast, unlike a plain drop', async ({ mdv }) => {
  mdv.native.insertImage(dropPath, true);

  await expect(mdv.page.locator('#toast')).toContainText('Saved as ' + dropPath + ' in this file’s folder.');
});

test('a dropped path with spaces and parens survives render -> sanitize -> decorate end-to-end', async ({ mdv }) => {
  mdv.native.insertImage(dropPath);
  await expect(mdv.page.locator('#editor')).toHaveValue('before ![alt text](<' + dropPath + '>)');

  const waitDone = mdv.waitForDebugLog('renderComplete');
  await mdv.call('leaveEdit');
  await waitDone;

  const src = await mdv.page.locator('#content img').getAttribute('src');
  const resolved = decodeURIComponent((src || '').split('__abs__/')[1] || '').replace(/\//g, '\\');
  // The whole point of <...>: a bare destination can't survive a space or an
  // unbalanced ")" in a real filename. If markdown-it's own destination
  // encoding, or decorate()'s windowsPathFrom()/toDocUrl() round trip,
  // mishandled it (e.g. left a literal "%20" instead of decoding back to a
  // real space, or truncated at the unbalanced ")"), this would resolve to
  // the wrong file, not just a differently-formatted string.
  expect(resolved).toBe(dropPath.replace(/\//g, '\\'));
});
