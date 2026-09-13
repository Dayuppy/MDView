// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- the theme
// button's 3-way cycle (light -> dark -> system -> light). Read once early
// in the project and found correct, but never given permanent regression
// coverage. Driven through a real click on the real #btn-theme button (the
// toggle itself works independently of any open document, but every other
// spec opens one first for a consistent starting page state, so this does
// too). Each leg of the cycle is its own test, establishing its own known
// starting theme via replaceS({theme: ...}) + applyPrefs() (both already
// exposed on __MDV_TEST) rather than depending on a previous test's click --
// so light->dark, dark->system, and system->light can fail independently
// and still each has a real precondition rather than a synthetic one.
//
// Each test checks the full chain one click is supposed to update: S.theme,
// the document.documentElement dataset.theme value CSS actually keys off
// of (compared, for the 'system' leg, against the real live
// matchMedia('(prefers-color-scheme: dark)') result -- never a hardcoded
// assumption about the test environment's OS preference), the sun/moon/auto
// icon visibility, and the toast text.

import { test, expect } from '../harness/fixtures.mjs';

async function resetToast(mdv) {
  await mdv.page.evaluate(() => { window.__MDV_TEST.els.toastEl.hidden = true; });
}

async function readThemeUi(mdv) {
  return mdv.page.evaluate(() => ({
    datasetTheme: document.documentElement.dataset.theme,
    sunHidden: document.getElementById('theme-sun').hidden,
    moonHidden: document.getElementById('theme-moon').hidden,
    autoHidden: document.getElementById('theme-auto').hidden,
    toastText: window.__MDV_TEST.els.toastEl.textContent,
  }));
}

test('theme button: light -> dark updates S.theme, dataset.theme, icons, and the toast', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'theme-light-dark.md' });
  await mdv.call('replaceS', { theme: 'light' });
  await mdv.call('applyPrefs');
  await resetToast(mdv);

  await mdv.page.locator('#btn-theme').click();

  expect((await mdv.state()).S.theme).toBe('dark');
  const ui = await readThemeUi(mdv);
  expect(ui.datasetTheme).toBe('dark');
  expect(ui).toMatchObject({ sunHidden: true, moonHidden: false, autoHidden: true });
  expect(ui.toastText).toBe('Theme: dark');
});

test('theme button: dark -> system updates S.theme, dataset.theme (against the real OS preference), icons, and the toast', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'theme-dark-system.md' });
  const sysPrefersDark = await mdv.page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  await mdv.call('replaceS', { theme: 'dark' });
  await mdv.call('applyPrefs');
  await resetToast(mdv);

  await mdv.page.locator('#btn-theme').click();

  expect((await mdv.state()).S.theme).toBe('system');
  const ui = await readThemeUi(mdv);
  expect(ui.datasetTheme).toBe(sysPrefersDark ? 'dark' : 'light');
  expect(ui).toMatchObject({ sunHidden: true, moonHidden: true, autoHidden: false });
  expect(ui.toastText).toBe('Theme: follow system');
});

test('theme button: system -> light updates S.theme, dataset.theme, icons, and the toast', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'theme-system-light.md' });
  await mdv.call('replaceS', { theme: 'system' });
  await mdv.call('applyPrefs');
  await resetToast(mdv);

  await mdv.page.locator('#btn-theme').click();

  expect((await mdv.state()).S.theme).toBe('light');
  const ui = await readThemeUi(mdv);
  expect(ui.datasetTheme).toBe('light');
  expect(ui).toMatchObject({ sunHidden: false, moonHidden: true, autoHidden: true });
  expect(ui.toastText).toBe('Theme: light');
});
