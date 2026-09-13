// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- the real zoom
// mechanism (Ctrl+/-/0, WebView2's own zoom API) lives entirely in native
// code and can't be driven from this harness; the one thing on this side
// worth testing is the inbound 'zoom' message handler's dedup: it should
// toast only when the reported percentage actually differs from the last
// one shown, not on every repeated report of the same value.
//
// 'zoom' here is a native-initiated-only message (FakeNative.handle()'s own
// 'zoom' case is the unrelated OUTBOUND direction -- the page asking native
// to change the zoom level -- and has no page-observable effect; see its
// comment in tools/dev/fake-native.mjs). So this delivers the inbound report
// the same way tests/specs/zen-mode.spec.mjs already delivers 'fs': directly
// via window.__mdvDeliver, bypassing FakeNative.handle entirely and going
// straight through the real bridge 'message' listener app.js registers.

import { test, expect } from '../harness/fixtures.mjs';

test('zoom: reporting the same percentage again does not re-toast', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'zoom-same.md' });
  await mdv.call('setLastZoomShown', 100);

  await mdv.page.evaluate(() => window.__mdvDeliver({ type: 'zoom', v: 100 }));

  // A direct, one-shot read, not expect(locator).toBeHidden() -- that assertion
  // auto-retries for up to its whole timeout, and toast()'s own 2200ms
  // auto-hide timer would eventually satisfy it regardless of whether a
  // toast ever showed in between, making it pass vacuously either way.
  expect(await mdv.page.evaluate(() => document.getElementById('toast').hidden)).toBe(true);
  expect((await mdv.state()).lastZoomShown).toBe(100);
});

test('zoom: a real percentage change shows the right toast', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'zoom-change.md' });
  await mdv.call('setLastZoomShown', 100);

  await mdv.page.evaluate(() => window.__mdvDeliver({ type: 'zoom', v: 125 }));

  await expect(mdv.page.locator('#toast')).toHaveText('Zoom 125%');
  expect((await mdv.state()).lastZoomShown).toBe(125);
});
