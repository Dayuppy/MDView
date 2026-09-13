// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- the Aa
// reading/accessibility panel's bindPref()/syncA11yControls() round-trip.
// Forward direction: does each control's own 'input' handler write S
// correctly, including the live %/em display spans? Dispatched as genuine
// 'input' events at the real elements (by id) rather than calling bindPref's
// internals directly -- every one of these 11 controls is naturally reachable
// through ordinary interaction with the real panel DOM (no `#a11y-overlay`
// visibility requirement -- the controls exist and dispatch events whether
// or not the panel is currently shown, matching the existing spellcheck-
// toggle/editor-typography specs' convention).
//
// Reverse direction: syncA11yControls() is the exact function `#set-reset`
// (already covered elsewhere) depends on -- scrambling S directly via the
// exposed `replaceS` and calling the real `syncA11yControls()` confirms every
// control reflects it back, using its own dedicated, more probing values.
//
// The boolean controls use values that actually flip from DEFAULTS (e.g.
// underlineLinks/dimImages default `true`, so they're driven to `false`
// rather than redundantly re-set to `true`) so every one of the 11 checks
// is a real discriminating transition, not just an assertion that a value
// stayed put.

import { test, expect } from '../harness/fixtures.mjs';

test('Aa panel: each control\'s own input handler writes S correctly (forward direction)', async ({ mdv }) => {
  const result = await mdv.page.evaluate(() => {
    const set = (id, prop, value) => {
      const el = document.getElementById(id);
      el[prop] = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('set-font', 'value', 'serif');
    set('set-size', 'value', '150');
    set('set-lh', 'value', '2');
    set('set-ls', 'value', '0.1');
    set('set-width', 'value', 'wide');
    set('set-motion', 'value', 'off');
    set('set-contrast', 'checked', true);   // false -> true
    set('set-underline', 'checked', false); // true -> false
    set('set-dim', 'checked', false);       // true -> false
    set('set-wrap', 'checked', true);       // false -> true
    set('set-spellcheck', 'checked', true); // false -> true

    const S = window.__MDV_TEST.state.S;
    return {
      font: S.font, fontSize: S.fontSize, lineHeight: S.lineHeight, letterSpacing: S.letterSpacing,
      contentWidth: S.contentWidth, motion: S.motion, highContrast: S.highContrast,
      underlineLinks: S.underlineLinks, dimImages: S.dimImages, codeWrap: S.codeWrap, spellcheck: S.spellcheck,
      outSize: document.getElementById('out-size').textContent,
      outLh: document.getElementById('out-lh').textContent,
      outLs: document.getElementById('out-ls').textContent,
    };
  });

  expect(result.font).toBe('serif');
  expect(result.fontSize).toBe(150);
  expect(result.outSize).toBe('150%');
  expect(result.lineHeight).toBe(2);
  expect(result.outLh).toBe('2.00');
  expect(result.letterSpacing).toBe(0.1);
  expect(result.outLs).toBe('0.10em');
  expect(result.contentWidth).toBe('wide');
  expect(result.motion).toBe('off');
  expect(result.highContrast).toBe(true);
  expect(result.underlineLinks).toBe(false);
  expect(result.dimImages).toBe(false);
  expect(result.codeWrap).toBe(true);
  expect(result.spellcheck).toBe(true);
});

test('Aa panel: syncA11yControls() reflects a scrambled S back into every control (reverse direction)', async ({ mdv }) => {
  await mdv.call('replaceS', {
    font: 'dyslexic', fontSize: 175, lineHeight: 1.3, letterSpacing: 0.05,
    contentWidth: 'narrow', motion: 'on', highContrast: false,
    underlineLinks: false, dimImages: false, codeWrap: false, spellcheck: true,
  });
  await mdv.call('syncA11yControls');

  const result = await mdv.page.evaluate(() => ({
    font: document.getElementById('set-font').value,
    size: document.getElementById('set-size').value,
    outSize: document.getElementById('out-size').textContent,
    lh: document.getElementById('set-lh').value,
    outLh: document.getElementById('out-lh').textContent,
    ls: document.getElementById('set-ls').value,
    outLs: document.getElementById('out-ls').textContent,
    width: document.getElementById('set-width').value,
    motion: document.getElementById('set-motion').value,
    contrast: document.getElementById('set-contrast').checked,
    underline: document.getElementById('set-underline').checked,
    dim: document.getElementById('set-dim').checked,
    wrap: document.getElementById('set-wrap').checked,
    spellcheck: document.getElementById('set-spellcheck').checked,
  }));

  expect(result.font).toBe('dyslexic');
  expect(result.size).toBe('175');
  expect(result.outSize).toBe('175%');
  expect(result.lh).toBe('1.3');
  expect(result.outLh).toBe('1.30');
  expect(result.ls).toBe('0.05');
  expect(result.outLs).toBe('0.05em');
  expect(result.width).toBe('narrow');
  expect(result.motion).toBe('on');
  expect(result.contrast).toBe(false);
  expect(result.underline).toBe(false);
  expect(result.dim).toBe(false);
  expect(result.wrap).toBe(false);
  expect(result.spellcheck).toBe(true);
});
