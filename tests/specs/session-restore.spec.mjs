// Session restore (docs/BACKLOG.md's Features section): app.js reopens
// S.recent[0] on launch when the "Reopen last document on launch" setting is
// on, this is the solo/first instance, and native had no CLI-argument
// document to hand off (window.__MDV_BOOT's solo/hasDoc flags -- see
// main.cpp's BuildBootScript). Deliberately JS-side: native never parses
// S.recent out of the settings blob, so this reuses the exact 'openPath'
// message a recent-files click already sends (tested elsewhere in
// recent-files.spec.mjs) rather than a new native code path -- these tests
// exercise the DECISION logic (does the restore attempt fire at all, with
// the right path), not openPath handling itself.

import { test, expect } from '../harness/fixtures.mjs';

const RESTORE_PATH = 'C:\\docs\\last-session.md';
const restoreSettings = (overrides = {}) => JSON.stringify({
  restoreLastDoc: true,
  recent: [{ path: RESTORE_PATH, name: 'last-session.md' }],
  ...overrides,
});

test.describe('restores when solo, doc-less, and enabled', () => {
  test.use({
    mdvBoot: { solo: true, hasDoc: false, settings: restoreSettings() },
    mdvPreloadDocs: [{ path: RESTORE_PATH, dir: 'C:\\docs', name: 'last-session.md', text: '# Last session\n' }],
  });

  test('posts openPath for S.recent[0] and the document actually opens', async ({ mdv }) => {
    const sent = mdv.lastReceived('openPath');
    expect(sent).toBeTruthy();
    expect(sent.path).toBe(RESTORE_PATH);
    expect(sent.nav).toBe('new');
    await mdv.waitForDebugLog('renderComplete');
    const state = await mdv.state();
    expect(state.doc.path).toBe(RESTORE_PATH);
  });
});

test.describe('does not restore', () => {
  test('when restoreLastDoc is off (the default)', async ({ mdv }) => {
    // No test.use() override in this one -- the shared fixture's plain
    // defaults (settings: null, so S.restoreLastDoc stays DEFAULTS' false).
    expect(mdv.lastReceived('openPath')).toBeUndefined();
  });

  test.describe('when a second instance', () => {
    test.use({
      mdvBoot: { solo: false, hasDoc: false, settings: restoreSettings() },
      mdvPreloadDocs: [{ path: RESTORE_PATH, dir: 'C:\\docs', name: 'last-session.md', text: '# Last session\n' }],
    });
    test('BOOT.solo is false', async ({ mdv }) => {
      expect(mdv.lastReceived('openPath')).toBeUndefined();
    });
  });

  test.describe('when native already handed off a CLI document', () => {
    test.use({
      mdvBoot: { solo: true, hasDoc: true, settings: restoreSettings() },
      mdvPreloadDocs: [{ path: RESTORE_PATH, dir: 'C:\\docs', name: 'last-session.md', text: '# Last session\n' }],
    });
    test('BOOT.hasDoc is true', async ({ mdv }) => {
      expect(mdv.lastReceived('openPath')).toBeUndefined();
    });
  });

  test.describe('when there is no recent-files history', () => {
    test.use({
      mdvBoot: { solo: true, hasDoc: false, settings: restoreSettings({ recent: [] }) },
    });
    test('S.recent is empty', async ({ mdv }) => {
      expect(mdv.lastReceived('openPath')).toBeUndefined();
    });
  });
});
