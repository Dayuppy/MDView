// Live task checkboxes (docs/BACKLOG.md's "Features" #1): clicking a
// rendered task-list checkbox while reading should toggle it, write the
// change back into doc.source, and mark the document dirty -- without
// requiring Ctrl+E first. Two things make this worth testing directly
// rather than trusting the implementation:
//   1. decorate() (assets/app.js) force-disables every OTHER checkbox/radio
//      in the rendered document as a defense against raw inline HTML in a
//      malicious document faking interactive form controls -- the new
//      exemption for real task-list checkboxes must not accidentally widen
//      that hole to a hand-authored one.
//   2. enterEdit() reuses editor.value as-is whenever the document is
//      already dirty, rather than reseeding from doc.source -- a toggle
//      that updates doc.source without also updating editor.value would
//      silently revert itself the next time the reader enters edit mode.

import { test, expect } from '../harness/fixtures.mjs';

const DOC = '# Tasks\n\n- [ ] one\n- [x] two\n- [ ] three\n\n<input type="checkbox" id="fake"> not a real task item\n';

test('clicking a task checkbox toggles it and writes back to doc.source', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'tasks.md' });

  const boxes = mdv.page.locator('#content input.task-list-item-checkbox');
  await expect(boxes).toHaveCount(3);
  await expect(boxes.nth(0)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  for (let i = 0; i < 3; i++) await expect(boxes.nth(i)).toBeEnabled();

  // The hand-authored raw-HTML checkbox must stay inert -- decorate()'s
  // exemption is scoped to the real task-list-item-checkbox class only.
  await expect(mdv.page.locator('#content input#fake')).toBeDisabled();

  await boxes.nth(0).click();
  await expect(boxes.nth(0)).toBeChecked();

  const state = await mdv.state();
  expect(state.dirty).toBe(true);
  expect(state.doc.source).toContain('- [x] one');
  expect(state.doc.source).toContain('- [x] two');   // untouched item unaffected
  expect(state.doc.source).toContain('- [ ] three');
  // 'dirty' is a page -> native message (fake-native.mjs's inbound handler,
  // not an outbound one lastSent() would see) -- its own recorded state is
  // the observable proof the post() actually reached the bridge.
  expect(mdv.native.state.dirty).toBe(true);
});

test('a checkbox toggle survives entering edit mode afterward', async ({ mdv }) => {
  await mdv.openDoc(DOC, { name: 'tasks.md' });
  const boxes = mdv.page.locator('#content input.task-list-item-checkbox');

  await boxes.nth(2).click();   // toggles "three" on
  await mdv.call('enterEdit');

  const editorText = await mdv.editorValue();
  expect(editorText).toContain('- [x] three');
});
