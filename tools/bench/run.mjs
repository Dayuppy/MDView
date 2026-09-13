// Exe-level end-to-end benchmark -- the real out/MDView.debug.exe, real
// process launch, real WebView2 controller creation, real IPC, real DOM
// insertion. tools/bench/render-bench.mjs (pure-Node, md.render() only)
// catches the large majority of real render regressions in ~4 seconds, but
// can't see any of the cost this measures instead -- exactly the gap this
// fills. Every run's per-document min/median/MAD is appended to
// tools/bench/history/ (gitignored -- machine-specific timing, not meant to
// be compared across different hardware) for tools/bench/trend.mjs to chart
// later; tools/bench/compare.mjs is the one-shot gate against
// tools/bench/baseline.json (committed -- the shared, promoted reference
// point).
//
//   node tools/bench/run.mjs                  5 iterations/doc (default)
//   node tools/bench/run.mjs --iterations=10
//   node tools/bench/run.mjs --exe=out/MDView.debug.exe

import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const corpusDir = path.join(root, 'out', 'corpus');
const historyDir = path.join(__dirname, 'history');
const defaultExePath = path.join(root, 'out', 'MDView.debug.exe');

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Median Absolute Deviation -- matches render-bench.mjs's own choice: a
// robust spread measure not dominated by one slow outlier launch (a
// scheduler hiccup, a one-off antivirus scan of the freshly-built exe).
function mad(sorted, med) {
  const deviations = sorted.map((t) => Math.abs(t - med)).sort((a, b) => a - b);
  return median(deviations);
}

/** Launches the real exe once against `docPath`, returning the elapsed
 *  milliseconds (measured by the exe's own AppendLog timestamp, i.e. real
 *  wall-clock since process start) at the moment its first renderComplete
 *  fired -- process launch, WebView2 controller creation, navigation, and
 *  the full render, all included. */
async function timeOneRun(exePath, docPath, timeoutMs) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'mdv-bench-'));
  try {
    const log = path.join(workDir, 'run.log');
    const prof = path.join(workDir, 'run.json');
    await execFileAsync(exePath, [
      '--mdv-headless', `--mdv-log=${log}`, `--mdv-profile=${prof}`,
      `--mdv-timeout=${timeoutMs}`, '--mdv-exit-after=800', docPath,
    ], { timeout: timeoutMs + 15000 });

    const logText = await readFile(log, 'utf-8').catch(() => '');
    const m = logText.match(/\[[\d:.]+\s*\+\s*([\d.]+)ms\]\s*\[js:renderComplete\]/);
    if (!m) throw new Error(`no [js:renderComplete] log line for ${docPath} -- log:\n${logText}`);
    return Number(m[1]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function benchOne(exePath, docPath, iterations, timeoutMs) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    try {
      times.push(await timeOneRun(exePath, docPath, timeoutMs));
    } catch (err) {
      // One retry -- see tools/golden/layer-c.mjs's identical reasoning
      // (WebView2 controller creation has been observed taking 20s+ under
      // system load; launching one exe per iteration per document makes
      // hitting that window at least once likely over a full run).
      times.push(await timeOneRun(exePath, docPath, timeoutMs).catch(() => { throw err; }));
    }
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
  const iterations = Number(args.iterations || 5);
  const exePath = args.exe ? path.resolve(root, args.exe) : defaultExePath;
  const timeoutMs = Number(args.timeout || 60000);

  if (!existsSync(exePath)) {
    console.error(`No exe at ${exePath} -- run: .\\build.ps1 -Debug`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(corpusDir, 'manifest.json'), 'utf-8'));
  } catch {
    console.error(`No corpus manifest at ${corpusDir}\\manifest.json -- run: node tools/corpus/gen-corpus.mjs`);
    process.exit(1);
  }

  const results = {};
  const t0 = Date.now();
  for (const [name, meta] of Object.entries(manifest.docs)) {
    const docPath = path.join(corpusDir, meta.file);
    const r = await benchOne(exePath, docPath, iterations, timeoutMs);
    results[name] = r;
    console.log(
      `${name.padEnd(10)} min=${r.min.toFixed(0).padStart(6)}ms  median=${r.median.toFixed(0).padStart(6)}ms  ` +
      `mad=${r.mad.toFixed(0).padStart(5)}ms  bytes=${String(meta.bytes).padStart(7)}`,
    );
  }
  const totalMs = Date.now() - t0;
  console.log(`\nbench: ${Object.keys(results).length} docs, ${iterations} iterations each, ${(totalMs / 1000).toFixed(1)}s total`);

  await mkdir(historyDir, { recursive: true });
  const ranAt = new Date().toISOString();
  const entry = { corpusVersion: manifest.corpusVersion, iterations, results, totalMs, ranAt };
  const historyFile = path.join(historyDir, `${ranAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(historyFile, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
  console.log(`wrote ${path.relative(root, historyFile)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
