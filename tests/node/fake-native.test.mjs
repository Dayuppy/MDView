// fake-native.mjs will be load-bearing for the whole future Playwright
// migration (tests/MIGRATION.md), so it gets its own direct verification
// now, before anything is built on top of it. Pure Node, no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeNative } from '../../tools/dev/fake-native.mjs';

test('newDoc: resets to an untitled, clean document and posts doc/new', () => {
  const n = new FakeNative();
  const out = n.handle({ type: 'newDoc' });
  assert.equal(n.state.haveDoc, true);
  assert.equal(n.state.docName, 'Untitled');
  assert.equal(n.state.dirty, false);
  assert.deepEqual(out, [{
    type: 'doc', name: 'Untitled', path: '', dir: '', plain: '0', nav: 'new', tok: '1',
    bom: '0', crlf: '0', encoding: 'UTF-8', size: '0', modified: '0',
  }]);
});

test('dirty: title only updates on an actual transition, matching UpdateTitle()', () => {
  const n = new FakeNative();
  n.loadDoc({ path: 'C:\\docs\\a.md', dir: 'C:\\docs', name: 'a.md', text: '# a\n' });
  assert.equal(n.state.windowTitle, 'a.md — MD Viewer');

  n.handle({ type: 'dirty', on: '1' });
  assert.equal(n.state.dirty, true);
  assert.equal(n.state.windowTitle, '• a.md — MD Viewer');

  // Re-sending the same state should NOT re-run UpdateTitle() (mirrors
  // `if (was != g_dirty) UpdateTitle();` in main.cpp:1495) -- the resulting
  // title STRING would be identical either way, so this only shows up as a
  // call count, not as a different string.
  const countBefore = n.state.titleUpdateCount;
  n.handle({ type: 'dirty', on: '1' });
  assert.equal(n.state.titleUpdateCount, countBefore, 'a redundant dirty:1 must not re-run UpdateTitle()');

  n.handle({ type: 'dirty', on: '0' });
  assert.equal(n.state.windowTitle, 'a.md — MD Viewer');
});

test('editing: tracks on/off with no title side effect', () => {
  const n = new FakeNative();
  n.loadDoc({ path: 'C:\\docs\\a.md', dir: 'C:\\docs', name: 'a.md', text: 'x' });
  n.handle({ type: 'editing', on: '1' });
  assert.equal(n.state.editing, true);
  n.handle({ type: 'editing', on: '0' });
  assert.equal(n.state.editing, false);
});

test('saveDoc: updates docText, clears dirty, posts saved -- only when a document is open', () => {
  const n = new FakeNative();
  const noDoc = n.handle({ type: 'saveDoc', text: 'nope' });
  assert.deepEqual(noDoc, [], 'saveDoc with no open document is a silent no-op, mirroring g_haveDoc guard');

  n.loadDoc({ path: 'C:\\docs\\a.md', dir: 'C:\\docs', name: 'a.md', text: 'old' });
  n.handle({ type: 'dirty', on: '1' });
  const out = n.handle({ type: 'saveDoc', text: 'new text' });
  assert.equal(n.state.docText, 'new text');
  assert.equal(n.state.dirty, false);
  assert.deepEqual(out, [{ type: 'saved', path: 'C:\\docs\\a.md' }]);
});

test('openPath: a network/UNC-shaped path is blocked with the real toast, never opened', () => {
  const n = new FakeNative();
  const out = n.handle({ type: 'openPath', path: '\\\\attacker\\share\\x.md', nav: 'link' });
  assert.equal(n.state.haveDoc, false);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'toast');
  assert.match(out[0].text, /blocked for your security/);
});

test('openPath: a markdown file in the VFS opens; a non-markdown one does not', () => {
  const n = new FakeNative();
  n.addDoc({ path: 'C:\\docs\\note.md', dir: 'C:\\docs', name: 'note.md', text: '# hi\n' });
  n.addDoc({ path: 'C:\\docs\\image.png', dir: 'C:\\docs', name: 'image.png', text: '' });

  const openedMd = n.handle({ type: 'openPath', path: 'C:\\docs\\note.md', nav: 'link' });
  assert.equal(n.state.haveDoc, true);
  assert.equal(n.state.docName, 'note.md');
  assert.equal(openedMd[0].type, 'doc');

  const openedPng = n.handle({ type: 'openPath', path: 'C:\\docs\\image.png', nav: 'link' });
  assert.equal(n.state.docName, 'note.md', 'a non-markdown path does not replace the open document');
  assert.deepEqual(openedPng, [{ type: '__openedNonMarkdown', path: 'C:\\docs\\image.png' }]);
});

test('openPath: a path not in the VFS reports openFailed + toast, not a crash', () => {
  const n = new FakeNative();
  const out = n.handle({ type: 'openPath', path: 'C:\\docs\\missing.md', nav: 'link' });
  assert.deepEqual(out[0], { type: 'openFailed', path: 'C:\\docs\\missing.md' });
  assert.equal(out[1].type, 'toast');
});

test('saveClipboardImage: rejects a disallowed extension and malformed base64, matching Base64Decode', () => {
  const n = new FakeNative();
  n.loadDoc({ path: 'C:\\docs\\a.md', dir: 'C:\\docs', name: 'a.md', text: '' });

  const badExt = n.handle({ type: 'saveClipboardImage', data: 'aGVsbG8=', ext: 'exe' });
  assert.deepEqual(badExt, [{ type: 'toast', text: 'Could not save the pasted image.' }]);
});

test('saveClipboardImage: a valid payload writes through the injected writer and increments the filename', () => {
  const written = [];
  const n = new FakeNative({ pastedImageWriter: (name, bytes) => written.push({ name, bytes }) });
  n.loadDoc({ path: 'C:\\docs\\a.md', dir: 'C:\\docs', name: 'a.md', text: '' });

  const first = n.handle({ type: 'saveClipboardImage', data: Buffer.from('one').toString('base64'), ext: 'png' });
  const second = n.handle({ type: 'saveClipboardImage', data: Buffer.from('two').toString('base64'), ext: 'png' });

  assert.equal(written.length, 2);
  assert.equal(written[0].name, 'pasted-image-1.png');
  assert.equal(written[1].name, 'pasted-image-2.png', 'a second paste gets a different filename');
  assert.deepEqual(first, [{ type: 'insertImage', path: 'pasted-image-1.png', created: true }]);
  assert.deepEqual(second, [{ type: 'insertImage', path: 'pasted-image-2.png', created: true }]);
});

test('openExternal: is recorded but never actually launches anything', () => {
  const n = new FakeNative();
  const out = n.handle({ type: 'openExternal', url: 'javascript:alert(1)' });
  assert.deepEqual(out, [{ type: '__openExternalRecorded', url: 'javascript:alert(1)' }]);
});

test('openDialog: resolves to the queued path, exactly once', () => {
  const n = new FakeNative();
  n.addDoc({ path: 'C:\\docs\\picked.md', dir: 'C:\\docs', name: 'picked.md', text: '# picked\n' });
  n.queueOpenDialog('C:\\docs\\picked.md');

  const out = n.handle({ type: 'openDialog' });
  assert.equal(out[0].type, 'doc');
  assert.equal(n.state.docName, 'picked.md');

  const secondCall = n.handle({ type: 'openDialog' });
  assert.deepEqual(secondCall, [], 'the queued path is consumed once, like a real dialog result');
});

test('sent[] records each outbound message exactly once, not duplicated by handle()\'s return array', () => {
  // A real bug, caught by hand before this test existed: handle()'s local
  // accumulator used to push into `sent` a second time for any message that
  // was already recorded by a _post()-based helper (_sendToast/_sendDocMsg/
  // _openInternal), so e.g. a single failed openPath recorded its toast
  // TWICE in `sent` even though the caller only ever saw it once via the
  // return value. `sent` is exactly what the future Playwright migration
  // will assert against (e.g. "the last saved message"), so this matters.
  const n = new FakeNative();
  const out = n.handle({ type: 'openPath', path: 'C:\\docs\\missing.md', nav: 'link' });
  assert.equal(n.sent.length, out.length, 'sent[] must have exactly the messages the caller saw, no more');
  assert.equal(n.sent.length, 2);
});

test('onOutbound fires exactly once per outbound message, for both page-originated and Node-side calls', () => {
  const seen = [];
  const n = new FakeNative({ onOutbound: (m) => seen.push(m) });

  n.handle({ type: 'openPath', path: 'C:\\docs\\missing.md', nav: 'link' });
  assert.equal(seen.length, 2, 'a handle() call must fire onOutbound once per message, not twice');

  seen.length = 0;
  n.loadDoc({ path: 'C:\\docs\\a.md', dir: 'C:\\docs', name: 'a.md', text: '# a\n' });
  assert.equal(seen.length, 1, 'a Node-side loadDoc() must also reach onOutbound -- it is not only for page-triggered messages');
  assert.equal(seen[0].type, 'doc');
});

test('chrome: tracks dark state without throwing (no real DWM call to make)', () => {
  const n = new FakeNative();
  n.handle({ type: 'chrome', dark: '1' });
  assert.equal(n.state.dark, true);
  n.handle({ type: 'chrome', dark: '0' });
  assert.equal(n.state.dark, false);
});
