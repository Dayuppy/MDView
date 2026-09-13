// Noise-aware regression gate: compares the most recent tools/bench/run.mjs
// result against the committed tools/bench/baseline.json, flagging a
// document only when its median moved by more than
// max(5% of the baseline median, 3x the baseline's own MAD).
//
// A plain percentage-only threshold would misfire constantly here --
// tools/bench/run.mjs's own real-world runs have shown MAD values in the
// thousands of milliseconds for some documents (WebView2 controller
// creation and vendor-script loading noise, not this app's own render
// cost), so 5% of an already-noisy baseline can be smaller than a single
// MAD -- the 3xMAD floor is what keeps that from reading as a regression
// every time system load happens to be a little higher than usual.
//
//   node tools/bench/compare.mjs                 compares against the LATEST history entry
//   node tools/bench/compare.mjs --file=tools/bench/history/<name>.json

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const historyDir = path.join(__dirname, 'history');
const baselinePath = path.join(__dirname, 'baseline.json');

async function latestHistoryFile() {
  const files = (await readdir(historyDir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;
  return path.join(historyDir, files[files.length - 1]);
}

/** Pure comparison logic, no I/O -- one report per document present in
 *  BOTH baseline and fresh (a document only in one or the other is noted
 *  separately, not silently ignored). */
export function compareResults(baseline, fresh) {
  const reports = [];
  const names = new Set([...Object.keys(baseline.results), ...Object.keys(fresh.results)]);
  for (const name of names) {
    const b = baseline.results[name];
    const f = fresh.results[name];
    if (!b) { reports.push({ name, status: 'new', fresh: f }); continue; }
    if (!f) { reports.push({ name, status: 'missing', baseline: b }); continue; }
    const threshold = Math.max(0.05 * b.median, 3 * b.mad);
    const delta = f.median - b.median;
    const flagged = Math.abs(delta) > threshold;
    reports.push({ name, status: flagged ? 'FLAG' : 'ok', baselineMedian: b.median, freshMedian: f.median, delta, threshold });
  }
  return reports;
}

export function formatReport(r) {
  if (r.status === 'new') return `  ${r.name}: new document, no baseline yet (run tools/bench/promote.mjs once accepted)`;
  if (r.status === 'missing') return `  ${r.name}: in baseline but not in this run (removed from the corpus?)`;
  const pct = r.baselineMedian ? ((r.delta / r.baselineMedian) * 100).toFixed(1) : '?';
  const sign = r.delta >= 0 ? '+' : '';
  return `  ${r.name.padEnd(10)} ${r.status === 'FLAG' ? 'FLAG' : 'ok  '}  ` +
    `baseline=${r.baselineMedian.toFixed(0)}ms  fresh=${r.freshMedian.toFixed(0)}ms  ` +
    `delta=${sign}${r.delta.toFixed(0)}ms (${sign}${pct}%)  threshold=±${r.threshold.toFixed(0)}ms`;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }));

  if (!existsSync(baselinePath)) {
    console.error(`No baseline at ${path.relative(root, baselinePath)} -- run tools/bench/run.mjs then tools/bench/promote.mjs once.`);
    process.exit(1);
  }
  const baseline = JSON.parse(await readFile(baselinePath, 'utf-8'));

  const freshFile = args.file ? path.resolve(root, args.file) : await latestHistoryFile();
  if (!freshFile) {
    console.error('No tools/bench/history/*.json entries -- run tools/bench/run.mjs first.');
    process.exit(1);
  }
  const fresh = JSON.parse(await readFile(freshFile, 'utf-8'));

  console.log(`bench:compare -- baseline ranAt=${baseline.ranAt}, fresh=${path.basename(freshFile)} (ranAt=${fresh.ranAt})`);
  const reports = compareResults(baseline, fresh);
  for (const r of reports) console.log(formatReport(r));

  const flagged = reports.filter((r) => r.status === 'FLAG').length;
  console.log(`\n${reports.length} documents, ${flagged} flagged`);
  process.exit(flagged ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
