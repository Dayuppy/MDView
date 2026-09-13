// Pure-Node renderer benchmark -- no exe, no WebView2, no browser. Times
// md.parse()+md.render() (the real renderer, via tools/golden/render-node.mjs)
// against every document in the seeded corpus (tools/corpus/gen-corpus.mjs),
// several iterations each, reporting min/median/MAD. Catches the large
// majority of real render regressions (a plugin upgrade, a bad regex in
// mdvSplitFrontMatter, an hljs change) in ~4 seconds -- the fast tier's own
// regression signal, not a replacement for the exe-level end-to-end bench
// (tools/bench/run.mjs, not yet built), which also has to account for
// WebView2 startup, IPC, and DOM insertion cost this can't see at all.
//
//   node tools/bench/render-bench.mjs
//   node tools/bench/render-bench.mjs --iterations=30 --json=out/bench-result.json

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { loadRenderer } from '../golden/render-node.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const corpusDir = path.join(root, 'out', 'corpus');

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Median Absolute Deviation -- a robust spread measure, unlike stddev not
// dominated by one slow outlier iteration (a GC pause, a scheduler hiccup).
function mad(sorted, med) {
  const deviations = sorted.map((t) => Math.abs(t - med)).sort((a, b) => a - b);
  return median(deviations);
}

async function benchOne(md, text, iterations) {
  const times = [];
  // One untimed warm-up render -- JIT warm-up cost would otherwise dominate
  // the first real sample and skew min/median for a short iteration count.
  md.render(text, {});
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    md.render(text, {});
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const med = median(times);
  return { min: times[0], median: med, mad: mad(times, med), max: times[times.length - 1], iterations };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }));
  const iterations = Number(args.iterations || 15);

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(corpusDir, 'manifest.json'), 'utf-8'));
  } catch {
    console.error(`No corpus manifest at ${corpusDir}\\manifest.json -- run: node tools/corpus/gen-corpus.mjs`);
    process.exit(1);
  }

  const { md } = await loadRenderer();
  const results = {};
  const t0 = performance.now();
  for (const [name, meta] of Object.entries(manifest.docs)) {
    const text = await readFile(path.join(corpusDir, meta.file), 'utf-8');
    const r = await benchOne(md, text, iterations);
    results[name] = r;
    console.log(
      `${name.padEnd(10)} min=${r.min.toFixed(2).padStart(7)}ms  median=${r.median.toFixed(2).padStart(7)}ms  ` +
      `mad=${r.mad.toFixed(2).padStart(6)}ms  bytes=${String(meta.bytes).padStart(7)}`,
    );
  }
  const totalMs = performance.now() - t0;
  console.log(`\nrender-bench: ${Object.keys(results).length} docs, ${iterations} iterations each, ${totalMs.toFixed(0)}ms total`);

  if (args.json) {
    const out = { corpusVersion: manifest.corpusVersion, iterations, results, totalMs, ranAt: new Date().toISOString() };
    const jsonPath = path.isAbsolute(args.json) ? args.json : path.join(root, args.json);
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    console.log(`wrote ${jsonPath}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
