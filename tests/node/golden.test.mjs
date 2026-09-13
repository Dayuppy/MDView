// Golden-snapshot tooling (docs/BACKLOG.md's tooling-foundation item, Layer
// B/C). Covers the pure-logic pieces directly -- normalizeHtml() (Layer B),
// parseDomSummaryLine() (Layer C's log-line parser), and
// compareSnapshot()/formatReport() (the counter-deltas-first review output).
// Layer C's real captureDomSummary() (spawns the real exe) is exercised by
// tools/regression.ps1 instead -- it needs a built out/MDView.debug.exe,
// the same reason golden:check/update keep it behind an explicit
// --with-layer-c flag rather than running it by default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHtml } from '../../tools/golden/layer-b.mjs';
import { parseDomSummaryLine } from '../../tools/golden/layer-c.mjs';
import { compareSnapshot, formatReport } from '../../tools/golden/snapshot.mjs';

test('normalizeHtml: collapses a .katex subtree to its embedded TeX source, keeps hljs spans untouched', async () => {
  const { renderHtml } = await import('../../tools/golden/render-node.mjs');
  const html = await renderHtml('Inline $x^2$ math and a fence:\n\n```js\nconst x = 1;\n```\n');
  const normalized = normalizeHtml(html);
  assert.match(normalized, /\[KATEX:x\^2\]/);
  assert.doesNotMatch(normalized, /katex-mathml|katex-html/);
  assert.match(normalized, /class="hljs-keyword"/);
  assert.match(normalized, /class="hljs-number"/);
});

test('normalizeHtml: a document with no math is unaffected', () => {
  const html = '<h1>Title</h1>\n<p>Plain text, no formulas.</p>\n';
  assert.equal(normalizeHtml(html), html);
});

test('normalizeHtml: two adjacent .katex spans (not nested in each other) both collapse independently', () => {
  const html = '<p><span class="katex"><span class="a">x</span>' +
    '<annotation encoding="application/x-tex">a</annotation></span> and ' +
    '<span class="katex"><span class="b">y</span>' +
    '<annotation encoding="application/x-tex">b</annotation></span></p>';
  assert.equal(normalizeHtml(html), '<p>[KATEX:a] and [KATEX:b]</p>');
});

test('parseDomSummaryLine: numeric fields become real numbers, ariaBusy stays a literal string', () => {
  const parsed = parseDomSummaryLine('headings=3 tables=0 ariaBusy=false');
  assert.equal(parsed.headings, 3);
  assert.equal(parsed.tables, 0);
  assert.equal(parsed.ariaBusy, 'false');
  assert.equal(typeof parsed.headings, 'number');
  assert.equal(typeof parsed.ariaBusy, 'string');
});

test('compareSnapshot: identical snapshots report ok with no deltas', () => {
  const snap = {
    layerA: { tokenTypesHash: 'aaa' },
    layerB: { normalizedHash: 'bbb', sample: 's' },
    layerC: { headings: 3, tables: 1 },
  };
  const report = compareSnapshot('doc', snap, JSON.parse(JSON.stringify(snap)));
  assert.equal(report.ok, true);
  assert.equal(report.layerA, null);
  assert.equal(report.layerB, null);
  assert.equal(report.layerC, null);
});

test('compareSnapshot: a Layer C counter change is reported as a specific before/after delta, not just "changed"', () => {
  const stored = { layerA: { tokenTypesHash: 'x' }, layerB: { normalizedHash: 'y', sample: 's' }, layerC: { headings: 3, tables: 1 } };
  const fresh = { layerA: { tokenTypesHash: 'x' }, layerB: { normalizedHash: 'y', sample: 's' }, layerC: { headings: 3, tables: 0 } };
  const report = compareSnapshot('doc', stored, fresh);
  assert.equal(report.ok, false);
  assert.equal(report.layerA, null);
  assert.equal(report.layerB, null);
  assert.deepEqual(report.layerC.deltas, [{ key: 'tables', before: 1, after: 0 }]);
});

test('compareSnapshot: Layer A/B hash mismatches are flagged independently of Layer C', () => {
  const stored = { layerA: { tokenTypesHash: 'x' }, layerB: { normalizedHash: 'y', sample: 'old' } };
  const fresh = { layerA: { tokenTypesHash: 'x-changed' }, layerB: { normalizedHash: 'y', sample: 'old' } };
  const report = compareSnapshot('doc', stored, fresh);
  assert.equal(report.ok, false);
  assert.deepEqual(report.layerA, { changed: true });
  assert.equal(report.layerB, null);
});

test('formatReport: an OK report is a single line; a mismatch leads with the Layer C deltas', () => {
  const ok = compareSnapshot('doc', { layerA: { tokenTypesHash: 'a' }, layerB: { normalizedHash: 'b', sample: '' } },
    { layerA: { tokenTypesHash: 'a' }, layerB: { normalizedHash: 'b', sample: '' } });
  assert.equal(formatReport(ok), '  doc: OK');

  const stored = { layerA: { tokenTypesHash: 'x' }, layerB: { normalizedHash: 'y', sample: '' }, layerC: { headings: 3 } };
  const fresh = { layerA: { tokenTypesHash: 'x' }, layerB: { normalizedHash: 'y', sample: '' }, layerC: { headings: 5 } };
  const mismatch = compareSnapshot('doc', stored, fresh);
  const text = formatReport(mismatch);
  assert.match(text, /doc: MISMATCH/);
  assert.match(text, /layerC\.headings: 3 -> 5/);
});
