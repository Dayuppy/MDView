// Layer C: the post-sanitize/decorate DOM digest, captured through the REAL
// exe -- the one layer that needs it, since decorate() and the sanitize
// pipeline it runs after are only real inside a live WebView2 page, not the
// pure-Node vm sandbox Layers A/B run in. This is exactly
// debugDomSummary()'s own counters (assets/app.js), the structural
// fingerprint tools/regression.ps1 already checks -- but as a genuine
// stored baseline compared automatically, not a magic hardcoded number
// per Check() call (e.g. `headings=17`) that has to be hand-updated by
// whoever last touched demo.md, whether or not their change was the one
// this specific number was meant to catch.
//
// Mirrors tools/regression.ps1's own `Run` helper's exe invocation
// (--mdv-headless/--mdv-log=/--mdv-timeout=/--mdv-exit-after=) closely
// enough that a change to one should prompt checking the other.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

/** Parses one `[js:domSummary] headings=3 tables=1 ...` log line into a
 *  plain object of counters, numeric where the value looks like one (every
 *  current field does; `ariaBusy` is the one exception, kept as its literal
 *  'true'/'false' string). */
export function parseDomSummaryLine(line) {
  const out = {};
  for (const pair of line.trim().split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    out[key] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}

async function captureDomSummaryOnce(exePath, docPath, timeoutMs) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'mdv-golden-layerc-'));
  try {
    const log = path.join(workDir, 'run.log');
    const prof = path.join(workDir, 'run.json');
    await execFileAsync(exePath, [
      '--mdv-headless', `--mdv-log=${log}`, `--mdv-profile=${prof}`,
      `--mdv-timeout=${timeoutMs}`, '--mdv-exit-after=800', docPath,
    ], { timeout: timeoutMs + 15000 });

    const logText = await readFile(log, 'utf-8').catch(() => '');
    const m = logText.match(/\[js:domSummary\] (.+)/);
    if (!m) {
      throw new Error(`no [js:domSummary] log line for ${docPath} -- log:\n${logText}`);
    }
    return parseDomSummaryLine(m[1]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Runs the real exe headlessly against `docPath` and returns its
 *  debugDomSummary() counters. Throws if the exe never produced one (a
 *  crash, a hang past `timeoutMs`, or a document type domSummary doesn't
 *  apply to). One retry on a genuine launch failure -- WebView2 controller
 *  creation has been observed taking 20s+ under system load (this
 *  project's own README/CLAUDE.md note this), and launching one exe per
 *  corpus document back-to-back makes hitting that window at least once
 *  more likely than any single tools/regression.ps1 scenario sees. */
export async function captureDomSummary(exePath, docPath, { timeoutMs = 60000 } = {}) {
  try {
    return await captureDomSummaryOnce(exePath, docPath, timeoutMs);
  } catch (firstErr) {
    try {
      return await captureDomSummaryOnce(exePath, docPath, timeoutMs);
    } catch {
      throw firstErr;   // the original failure is more informative than the retry's
    }
  }
}
