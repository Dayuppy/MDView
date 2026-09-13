// docs/BACKLOG.md's hygiene note: S.positions (app.js's remembered scroll
// positions, capped at 40 entries) evicted by first-insertion order, not
// least-recently-used -- so a document you'd just re-opened and scrolled in
// could still be the one dropped, while something untouched for weeks
// survived. rememberPosition() now delete-then-reinserts the touched key so
// Object.keys() order genuinely reflects recency.

import { test, expect } from '../harness/fixtures.mjs';

test('rememberPosition evicts the least-recently-touched entry, not just the first-inserted one', async ({ mdv }) => {
  await mdv.openDoc('# Seed\n', { name: 'seed.md' });

  // Pre-populate 40 entries, k1 (oldest) .. k40 (newest), at the cap.
  const positions = {};
  for (let i = 1; i <= 40; i++) positions[`C:\\docs\\k${i}.md`] = i;
  await mdv.call('setPositions', positions);

  // Touch k1 -- the currently-oldest entry -- by opening it and remembering
  // a position. Without the fix this is a same-key assignment that leaves
  // k1's Object.keys() position unchanged (still index 0, still "oldest").
  await mdv.openDoc('# k1\n', { name: 'k1.md' });
  await mdv.call('rememberPosition');

  // Now push a brand-new 41st entry over the cap.
  await mdv.openDoc('# k41\n', { name: 'k41.md' });
  await mdv.call('rememberPosition');

  const { S } = await mdv.state();
  expect(Object.keys(S.positions).length).toBe(40);
  expect(S.positions['C:\\docs\\k1.md']).toBeDefined();    // just touched -- must survive
  expect(S.positions['C:\\docs\\k2.md']).toBeUndefined();  // now genuinely the oldest -- evicted
  expect(S.positions['C:\\docs\\k41.md']).toBeDefined();
});
