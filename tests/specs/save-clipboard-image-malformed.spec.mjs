// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- the
// malformed-base64-rejection half of the old saveClipboardImage checks.
//
// The real successful-write round trip (a genuine file written to disk,
// plus "a second paste gets a different filename") STAYS in
// debugRunEditorTest()/becomes debugRunNativeTest(): FakeNative's
// saveClipboardImage handler never actually writes a file unless a
// pastedImageWriter callback is supplied, and the shared Playwright fixture
// doesn't supply one, so "a real file was written to disk" genuinely can't
// be verified through this harness. This rejection path is different -- a
// pure decode-and-toast branch FakeNative already faithfully simulates
// (see its saveClipboardImage case in tools/dev/fake-native.mjs: any
// payload with zero valid base64 characters decodes to a zero-length
// buffer, and `!bytes.length` alone triggers the toast), so it migrates
// cleanly on its own.
//
// Posted straight through the real bridge (window.chrome.webview.postMessage
// -- exactly what app.js's own module-scope post() calls; app.js's own
// bridge 'message' listener is what turns the resulting toast reply into
// the real #toast text) rather than driven through a real paste event: a
// real clipboard paste always yields valid base64 (the browser's own
// File/Blob-reading APIs guarantee that), so there is no realistic
// end-to-end path that ever hands native genuinely malformed data -- the
// same reasoning tests/specs/mermaid-error-recovery.spec.mjs uses for
// calling its target directly instead of contriving a fake real-UI path.
//
// The payload below is pure punctuation (no letters, digits, '+', '/' or
// '=') so it decodes to zero bytes no matter how leniently a base64
// decoder skips invalid characters. The ORIGINAL in-page test's payload
// ('not!!valid@@base64$$') mixes in enough valid base64-alphabet letters
// (n,o,t,v,a,l,i,d,b,a,s,e,6,4) that Node's own permissive
// Buffer.from(str, 'base64') would NOT reliably decode it to empty --
// unlike the real hand-written Base64Decode() (main.cpp) that string was
// written to exercise, which rejects outright on the very first
// out-of-alphabet character. A pure-punctuation payload is the one that
// actually proves the rejection branch under this harness's simulation.

import { test, expect } from '../harness/fixtures.mjs';

test('saveClipboardImage: malformed base64 is safely rejected (no file, no editor change)', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'clipboard-image-malformed.md' });
  const editorValueBefore = await mdv.editorValue();

  await mdv.page.evaluate(
    (msg) => window.chrome.webview.postMessage(msg),
    { type: 'saveClipboardImage', data: '!!!@@@$$$%%%^^^&&&***(((', ext: 'png' },
  );

  await expect(mdv.page.locator('#toast')).toHaveText('Could not save the pasted image.');
  expect(mdv.lastSent('insertImage')).toBeUndefined();
  expect(await mdv.editorValue()).toBe(editorValueBefore);
});
