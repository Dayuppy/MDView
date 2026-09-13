// Proves the whole fast-harness pipeline end to end: real app.js, real
// index.html/vendor assets served over the local HTTPS origin
// (tools/dev/origin.mjs), a real Chromium render, a fake native bridge
// (tools/dev/fake-native.mjs) standing in for the exe, and the
// BOOT.testHooks-gated window.__MDV_TEST surface (assets/app.js) driving
// the real toolbar logic directly. This is the milestone the whole tooling
// plan's Phase 2 was building toward -- see docs/BACKLOG.md.

import { test, expect } from '../harness/fixtures.mjs';

test('opens a real document and renders it through the real pipeline', async ({ mdv }) => {
  await mdv.openDoc('# Hello\n\nSome **bold** text.\n', { name: 'smoke.md' });

  const text = await mdv.page.locator('#content').innerText();
  expect(text).toContain('Hello');

  const domSummary = await mdv.waitForDebugLog('domSummary');
  expect(domSummary).toMatch(/headings=1/);
});

test('the __MDV_TEST hook reaches real internals: a toolbar action really edits the textarea', async ({ mdv }) => {
  await mdv.openDoc('# scratch\n', { name: 'toolbar.md' });
  await mdv.call('enterEdit');
  await mdv.setEditor('hello world', 6, 11); // selects "world"

  await mdv.call('TOOLBAR_ACTIONS.bold');

  expect(await mdv.editorValue()).toBe('hello **world**');
});

test('fake-native round-trip: saveDoc reaches the fake bridge and comes back as a real "saved" message', async ({ mdv }) => {
  await mdv.openDoc('draft', { name: 'save.md' });
  await mdv.call('enterEdit');
  await mdv.setEditor('draft v2', 0, 0);
  // setEditor writes editor.value directly (no real keystroke), so app.js's
  // own input-driven dirty-tracking never runs -- saveDoc() no-ops on a
  // clean document ("a clean document toasts instead of posting a save").
  // Set it explicitly via the hook's setter rather than faking an 'input'
  // event; this smoke test is proving the save round-trip works at all, not
  // re-testing dirty-tracking itself.
  await mdv.call('setDirty', true);

  await mdv.call('saveDoc', false);

  expect(mdv.native.state.docText).toBe('draft v2');
  expect(mdv.lastSent('saved')).toMatchObject({ type: 'saved' });
});
