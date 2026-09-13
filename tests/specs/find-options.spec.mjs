// docs/BACKLOG.md's Features #9: Find upgrades -- whole-word matching, a
// regex mode, and phrase matching across inline markup (a search for "bold
// text" should match "**bold** text", which the old per-text-node scan
// could never do since "bold" and " text" are separate DOM text nodes on
// either side of a <strong>). All three ride on one shared regex-based
// matcher (buildFindMatcher/collectMatches/collectEditorMatches in app.js)
// so read and edit mode can never disagree.

import { test, expect } from '../harness/fixtures.mjs';

async function openFindAndToggle(mdv, ids) {
  await mdv.page.locator('#btn-find').click();
  for (const id of ids) await mdv.page.locator('#' + id).click();
}

test('whole-word matching excludes a substring match inside a longer word (reading mode)', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nA cat sat. Please concatenate the files. The Cat sat again.\n', { name: 'word.md' });
  await openFindAndToggle(mdv, []);
  await mdv.call('runSearch', 'cat');
  await expect(mdv.page.locator('#find-count')).toHaveText('1 / 3');   // cat, con[cat]enate, Cat

  await openFindAndToggle(mdv, ['find-word']);
  await mdv.call('runSearch', 'cat');
  await expect(mdv.page.locator('#find-count')).toHaveText('1 / 2');   // just the two standalone words
});

test('whole-word matching works the same way in edit mode', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nA cat sat. Please concatenate the files.\n', { name: 'word-edit.md' });
  await mdv.call('enterEdit');
  await mdv.page.locator('#btn-find').click();
  await mdv.page.locator('#find-word').click();
  await mdv.call('runSearch', 'cat');
  const { matches } = await mdv.state();
  expect(matches.length).toBe(1);
});

test('regex mode interprets the query as a real pattern, not literal text', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nA cat sat. Please concatenate the files. The Cat sat again.\n', { name: 'regex.md' });
  await openFindAndToggle(mdv, ['find-regex']);
  await mdv.call('runSearch', '\\bcat\\b');
  await expect(mdv.page.locator('#find-count')).toHaveText('1 / 2');
});

test('an invalid regex pattern shows a friendly error instead of crashing or silently finding nothing', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nSome text.\n', { name: 'badregex.md' });
  await openFindAndToggle(mdv, ['find-regex']);
  await mdv.call('runSearch', '(unterminated');
  await expect(mdv.page.locator('#find-count')).toHaveText('Invalid regex');
});

test('a phrase spanning inline markup matches as one continuous phrase (reading mode)', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nSome **bold** text here.\n', { name: 'phrase.md' });
  await mdv.page.locator('#btn-find').click();
  await mdv.call('runSearch', 'bold text');
  await expect(mdv.page.locator('#find-count')).toHaveText('1 / 1');
});

test('a phrase does not falsely match across a paragraph/block boundary', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nFirst paragraph ends here.\n\nSecond paragraph starts here.\n', { name: 'noblock.md' });
  await mdv.page.locator('#btn-find').click();
  await mdv.call('runSearch', 'here.Second');
  await expect(mdv.page.locator('#find-count')).toHaveText('No results');
});

test('the whole-word and regex toggles persist across a reload the same way match-case already does', async ({ mdv }) => {
  await mdv.openDoc('# Doc\n\nText.\n', { name: 'persist.md' });
  await mdv.page.locator('#btn-find').click();
  await mdv.page.locator('#find-word').click();
  await mdv.page.locator('#find-regex').click();
  const { S } = await mdv.state();
  expect(S.findWord).toBe(true);
  expect(S.findRegex).toBe(true);
  await expect(mdv.page.locator('#find-word')).toHaveAttribute('aria-pressed', 'true');
  await expect(mdv.page.locator('#find-regex')).toHaveAttribute('aria-pressed', 'true');
});
