// tools/bench/compare.mjs's noise-aware regression gate (docs/BACKLOG.md's
// corpus+benchmarks item): flag a document only when its median moves by
// more than max(5% of the baseline median, 3x the baseline's own MAD).
// Covers the pure comparison logic directly -- tools/bench/run.mjs itself
// needs a built exe and takes minutes, so it's exercised live (see the
// commit history) rather than in this fast Node suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareResults } from '../../tools/bench/compare.mjs';

function makeResult(median, mad) {
  return { min: median - mad, median, mad, max: median + mad, iterations: 5 };
}

test('compareResults: a low-noise document flags a real, meaningful median shift', () => {
  const baseline = { results: { tiny: makeResult(2677, 93) } };
  const fresh = { results: { tiny: makeResult(3177, 93) } };   // +500ms, +18.7%
  const [report] = compareResults(baseline, fresh);
  assert.equal(report.status, 'FLAG');
  assert.equal(report.threshold, Math.max(0.05 * 2677, 3 * 93));
});

test('compareResults: a high-noise document does NOT flag a shift smaller than its own historical spread', () => {
  const baseline = { results: { mixed: makeResult(5494, 2482) } };
  const fresh = { results: { mixed: makeResult(5694, 2482) } };   // +200ms, +3.6%
  const [report] = compareResults(baseline, fresh);
  assert.equal(report.status, 'ok');
  // The 3xMAD floor (7446ms), not the 5% figure (275ms), is what's actually
  // gating here -- confirms the "max()", not just the percentage alone.
  assert.equal(report.threshold, 3 * 2482);
});

test('compareResults: an identical run against itself never flags', () => {
  const run = { results: { tiny: makeResult(2677, 93), math: makeResult(12553, 1945) } };
  const reports = compareResults(run, run);
  assert.ok(reports.every((r) => r.status === 'ok'));
});

test('compareResults: a document present only in the fresh run is reported as new, not silently skipped', () => {
  const baseline = { results: {} };
  const fresh = { results: { newdoc: makeResult(1000, 50) } };
  const [report] = compareResults(baseline, fresh);
  assert.equal(report.status, 'new');
});

test('compareResults: a document present only in the baseline is reported as missing, not silently skipped', () => {
  const baseline = { results: { gone: makeResult(1000, 50) } };
  const fresh = { results: {} };
  const [report] = compareResults(baseline, fresh);
  assert.equal(report.status, 'missing');
});
