// Unified entry point (docs/BACKLOG.md's tooling-foundation item) --
// orchestrates every other check tool in this repo rather than replacing
// any of them. Every step runs to completion regardless of earlier
// failures (so one broken check never hides another), then a final
// summary decides the exit code.
//
//   node tools/run-checks.mjs             fast tier -- no MSVC/WebView2,
//                                          target < 25s
//   node tools/run-checks.mjs --full       adds the build, test-textio,
//                                          golden C, the exe regression
//                                          suite, exe bench + baseline
//                                          compare, and a leftover-
//                                          MDView*-process check
//
// A step marked `gating: false` (the two raw benchmarks) always "passes"
// for the summary's purposes -- it has no pass/fail criterion of its own
// on the fast tier (tools/bench/compare.mjs is the actual gate, run
// separately right after tools/bench/run.mjs on --full) but is still
// worth running and watching for a crash.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function run(name, cmd, args, { gating = true } = {}) {
  console.log(`\n=== ${name} ===`);
  const t0 = Date.now();
  // shell: true -- npx/npm-installed binaries are .cmd shims on Windows;
  // spawning the bare name with shell:false fails with ENOENT there. Every
  // arg here is a fixed literal from this file, never untrusted input, so
  // shell interpretation carries no injection risk.
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  const ms = Date.now() - t0;
  if (result.error) console.log(`--- ${name}: spawn error: ${result.error.message}`);
  const ok = result.status === 0;
  console.log(`--- ${name}: ${ok ? 'OK' : 'FAILED'} (${(ms / 1000).toFixed(1)}s)`);
  return { name, ok: gating ? ok : true, ranMs: ms };
}

function checkLeftoverProcesses() {
  console.log('\n=== leftover MDView* processes ===');
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq MDView*', '/FO', 'CSV', '/NH'], { encoding: 'utf-8' });
  const output = (result.stdout || '').trim();
  // tasklist prints a literal "INFO: No tasks..." line (not CSV) when the
  // filter matches nothing -- anything else means a real leftover process.
  const ok = output === '' || /^INFO:/i.test(output);
  console.log(ok ? '--- leftover MDView* processes: OK (none running)' : `--- leftover MDView* processes: FAILED\n${output}`);
  return { name: 'leftover processes', ok };
}

async function main() {
  const full = process.argv.includes('--full');
  const results = [];

  results.push(run('lint', 'npx', ['eslint', '.']));
  results.push(run('parity', 'node', ['tools/check-parity.mjs']));
  results.push(run('accel-parity', 'node', ['tools/check-accel-parity.mjs']));
  results.push(run('node tests', 'node', ['tools/run-node-tests.mjs']));
  results.push(run('golden A+B', 'node', ['tools/golden/check.mjs']));
  results.push(run('playwright', 'npx', ['playwright', 'test', '--reporter=line']));
  results.push(run('render bench', 'node', ['tools/bench/render-bench.mjs'], { gating: false }));

  if (full) {
    results.push(run('build (debug)', 'pwsh', ['-NoProfile', '-File', 'build.ps1', '-Debug']));
    results.push(run('test-textio', 'pwsh', ['-NoProfile', '-File', 'build.ps1', '-Test']));
    results.push(run('golden C', 'node', ['tools/golden/check.mjs', '--with-layer-c']));
    results.push(run('exe regression suite', 'pwsh', ['-NoProfile', '-File', 'tools/regression.ps1']));
    results.push(run('exe bench', 'node', ['tools/bench/run.mjs'], { gating: false }));
    results.push(run('bench compare', 'node', ['tools/bench/compare.mjs']));
    results.push(checkLeftoverProcesses());
  }

  console.log(`\n${'='.repeat(50)}\nSummary (${full ? 'full' : 'fast'} tier)`);
  for (const r of results) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main();
