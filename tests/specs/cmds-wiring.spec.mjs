// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- CMDS.newDoc/
// reloadRequest/openRequest all gate on confirmDiscard() (already covered
// by tests/specs/confirm-discard.spec.mjs); this checks the WIRING
// specifically -- does a decline correctly post nothing, does an accept
// post the right message (and, for newDoc, arm pendingNewDoc)? window.confirm
// is a real native dialog here (dirty=true forces one) -- handled through
// Playwright's page.on('dialog') API, matching confirm-discard.spec.mjs.

import { test, expect } from '../harness/fixtures.mjs';

test('CMDS.newDoc: declining the discard prompt posts nothing', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'cmds-new-decline.md' });
  await mdv.call('setDirty', true);
  mdv.page.on('dialog', (d) => d.dismiss());

  await mdv.call('CMDS.newDoc');

  expect(mdv.native.received.some((m) => m.type === 'newDoc')).toBe(false);
  expect((await mdv.state()).pendingNewDoc).toBe(false);
});

test('CMDS.newDoc: accepting posts newDoc and arms pendingNewDoc', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'cmds-new-accept.md' });
  await mdv.call('setDirty', true);
  mdv.page.on('dialog', (d) => d.accept());

  await mdv.call('CMDS.newDoc');

  expect(mdv.lastReceived('newDoc')).toBeTruthy();
  expect((await mdv.state()).pendingNewDoc).toBe(true);
});

test('CMDS.reloadRequest: posts reload without prompting when nothing is dirty', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'cmds-reload.md' });
  await mdv.call('setDirty', false);
  let dialogFired = false;
  mdv.page.on('dialog', (d) => { dialogFired = true; d.dismiss(); });

  await mdv.call('CMDS.reloadRequest');

  expect(dialogFired).toBe(false);
  expect(mdv.lastReceived('reload')).toBeTruthy();
});

test('CMDS.openRequest: posts openDialog without prompting when nothing is dirty', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'cmds-open.md' });
  await mdv.call('setDirty', false);
  let dialogFired = false;
  mdv.page.on('dialog', (d) => { dialogFired = true; d.dismiss(); });

  await mdv.call('CMDS.openRequest');

  expect(dialogFired).toBe(false);
  expect(mdv.lastReceived('openDialog')).toBeTruthy();
});
