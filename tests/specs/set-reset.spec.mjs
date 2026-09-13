// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- two
// independent checks that happened to sit back-to-back in the old in-page
// harness:
//
// 1. "Reset to defaults" (#set-reset) in the Aa/reading-settings panel
//    resets only the fields that panel actually shows/controls, explicitly
//    KEEPing theme/sidebar/sidebarWidth/findCase/findWord/findRegex/recent/
//    positions (none of which live in that dialog, per the handler's own
//    comment). Verified precisely rather than trusting a manual count of
//    DEFAULTS' fields against the reset-list and the keep-list in the
//    handler: every field is set to a distinct non-default value, the
//    real button is clicked, and each field is checked to have landed where
//    it should -- if any field were missing from BOTH lists,
//    Object.assign({}, DEFAULTS, keep) would silently reset it too, which
//    this would catch. The Aa panel is opened through the real #btn-a11y
//    button (its own realistic opener) so the real #set-reset button is
//    actually visible/clickable; the non-default starting S is seeded via
//    the `replaceS` hook, since there's no realistic UI path to drive all 19
//    DEFAULTS fields to specific non-default values just to set up this one
//    check.
//
// 2. S.positions is a plain object keyed by the exact doc.path string
//    (rememberPosition()/the restore expression at the 'doc' message
//    handler both use exact property access, e.g. `S.positions[doc.path] ||
//    0`) -- the same pattern, and the same dependency on OpenDocument()'s
//    path canonicalization (main.cpp), as S.recent's dedup, which
//    tools/regression.ps1's case-dedup scenario already proves native
//    handles correctly (the same file opened via two different casings
//    always yields the identical g_docPath string). What that scenario does
//    NOT cover is whether this JS-side object-key lookup has any hidden case
//    tolerance of its own that would mask a native regression instead of
//    surfacing it -- verified directly here via the `setPositions` hook
//    (same pattern as tests/specs/positions-lru.spec.mjs) rather than
//    assumed from the pattern matching S.recent's.

import { test, expect } from '../harness/fixtures.mjs';

test('#set-reset resets only the reading-panel fields, preserving theme/sidebar/find*/recent/positions', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'set-reset.md' });

  // Real UI: open the Aa panel through its actual opener button so the real
  // #set-reset button (inside #a11y-overlay) is visible/clickable below.
  await mdv.page.locator('#btn-a11y').click();

  // Seed a synthetic, fully non-default S via the hook -- mirrors what
  // debugRunEditorTest() used to do manually before this moved out.
  await mdv.call('replaceS', {
    theme: 'dark', font: 'serif', fontSize: 150, lineHeight: 2.0,
    letterSpacing: 0.1, contentWidth: 'wide', motion: 'off',
    highContrast: true, underlineLinks: false, dimImages: false,
    codeWrap: true, sidebar: false, sidebarWidth: 400,
    findCase: true, findWord: true, findRegex: true,
    recent: [{ path: 'C:/custom.md', name: 'custom.md' }],
    positions: { 'C:/custom.md': 42 },
  });

  await mdv.page.locator('#set-reset').click();

  const { S } = await mdv.state();

  // Reading-panel fields: reset to DEFAULTS.
  expect(S.font).toBe('system');
  expect(S.fontSize).toBe(100);
  expect(S.lineHeight).toBe(1.6);
  expect(S.letterSpacing).toBe(0);
  expect(S.contentWidth).toBe('normal');
  expect(S.motion).toBe('auto');
  expect(S.highContrast).toBe(false);
  expect(S.underlineLinks).toBe(true);
  expect(S.dimImages).toBe(true);
  expect(S.codeWrap).toBe(false);

  // Fields outside the dialog: untouched by the reset.
  expect(S.theme).toBe('dark');
  expect(S.sidebar).toBe(false);
  expect(S.sidebarWidth).toBe(400);
  expect(S.findCase).toBe(true);
  expect(S.findWord).toBe(true);
  expect(S.findRegex).toBe(true);
  expect(S.recent).toEqual([{ path: 'C:/custom.md', name: 'custom.md' }]);
  expect(S.positions).toEqual({ 'C:/custom.md': 42 });
});

test('S.positions is keyed by the exact doc.path string, with no hidden case-insensitivity', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'positions-case.md' });

  await mdv.call('setPositions', { 'C:/case-test.md': 777 });

  const { S } = await mdv.state();
  expect(S.positions['C:/case-test.md']).toBe(777);
  expect(S.positions['C:/CASE-TEST.MD']).toBeUndefined();
});
