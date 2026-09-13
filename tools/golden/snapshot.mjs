// Builds and compares golden snapshots across all 3 layers for the whole
// corpus (tools/corpus/gen-corpus.mjs). One JSON file per document under
// tools/golden/snapshots/ -- small, individually diffable in a code review,
// and each layer's own field explains what changed without needing to
// decode a combined hash.
//
//   node tools/golden/update.mjs             regenerate + overwrite (A+B)
//   node tools/golden/update.mjs --with-layer-c   also regenerate C (needs
//                                                  a built out/MDView.debug.exe)
//   node tools/golden/check.mjs               regenerate fresh, diff against
//                                              the stored baseline, exit 1 on
//                                              any mismatch
//
// Layer C is deliberately NOT part of the default (no --with-layer-c) path:
// it needs a real, already-built debug exe and takes several real seconds
// per document (WebView2 controller creation), the same reason
// docs/BACKLOG.md's tools/run-checks.mjs entry keeps it out of the fast
// tier (`npm run check`) and only in `npm run check:full`.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { parseToTokens, renderHtml } from './render-node.mjs';
import { normalizeHtml } from './layer-b.mjs';
import { captureDomSummary } from './layer-c.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(__dirname, '..', '..');
export const corpusDir = path.join(root, 'out', 'corpus');
export const snapshotsDir = path.join(__dirname, 'snapshots');
export const defaultExePath = path.join(root, 'out', 'MDView.debug.exe');

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

/** Loads the corpus manifest, failing with a clear pointer to the generator
 *  rather than an ENOENT stack trace -- matches tools/bench/render-bench.mjs's
 *  own error message for the identical precondition. */
export async function loadManifest() {
  try {
    return JSON.parse(await readFile(path.join(corpusDir, 'manifest.json'), 'utf-8'));
  } catch {
    throw new Error(`No corpus manifest at ${corpusDir}\\manifest.json -- run: node tools/corpus/gen-corpus.mjs`);
  }
}

/** Builds one document's snapshot. Layer A is a token-type-stream
 *  fingerprint (structural, not textual -- matches render-node.test.mjs's
 *  own "compare as plain strings, not the cross-realm token objects"
 *  approach); Layer B is the normalized-HTML hash plus a truncated sample
 *  for a human reading a diff; Layer C (only when `exePath` is given) is
 *  the real domSummary counters themselves, kept as real numbers rather
 *  than hashed, since the whole point of "counter-deltas-first" review is
 *  showing WHICH counter moved and by how much. */
export async function buildSnapshot(name, text, docPath, { exePath } = {}) {
  const { tokens } = await parseToTokens(text);
  const tokenShape = Array.from(tokens, (t) => `${t.type}:${t.tag}`).join('\n');
  const html = await renderHtml(text);
  const normalized = normalizeHtml(html);

  const snapshot = {
    layerA: { tokenTypesHash: sha256(tokenShape) },
    layerB: { normalizedHash: sha256(normalized), sample: normalized.slice(0, 500) },
  };
  if (exePath) {
    snapshot.layerC = await captureDomSummary(exePath, docPath);
  }
  return snapshot;
}

export async function readStoredSnapshot(name) {
  const file = path.join(snapshotsDir, `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf-8'));
}

export async function writeSnapshot(name, snapshot) {
  await mkdir(snapshotsDir, { recursive: true });
  await writeFile(path.join(snapshotsDir, `${name}.json`), JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
}

/** Every stored snapshot filename with no corresponding manifest entry --
 *  a doc removed from the corpus generator whose stale snapshot would
 *  otherwise sit there forever, never regenerated, never flagged. */
export async function findOrphanedSnapshots(manifest) {
  if (!existsSync(snapshotsDir)) return [];
  const known = new Set(Object.keys(manifest.docs));
  const files = await readdir(snapshotsDir);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).filter((n) => !known.has(n));
}

/** Compares `fresh` against `stored` for one document, returning a report
 *  object -- never throws, never prints; callers decide how to render it.
 *  Layer C's diff is counter-deltas-first: which fields actually differ,
 *  and their before/after values, not just "changed". */
export function compareSnapshot(name, stored, fresh) {
  const report = { name, ok: true, layerA: null, layerB: null, layerC: null };

  if (stored.layerA.tokenTypesHash !== fresh.layerA.tokenTypesHash) {
    report.ok = false;
    report.layerA = { changed: true };
  }
  if (stored.layerB.normalizedHash !== fresh.layerB.normalizedHash) {
    report.ok = false;
    report.layerB = { changed: true, storedSample: stored.layerB.sample, freshSample: fresh.layerB.sample };
  }
  if (stored.layerC && fresh.layerC) {
    const deltas = [];
    const keys = new Set([...Object.keys(stored.layerC), ...Object.keys(fresh.layerC)]);
    for (const key of keys) {
      const before = stored.layerC[key];
      const after = fresh.layerC[key];
      if (before !== after) deltas.push({ key, before, after });
    }
    if (deltas.length) { report.ok = false; report.layerC = { deltas }; }
  }
  return report;
}

/** Human-readable rendering of one compareSnapshot() report -- counter
 *  deltas printed first (the part a reviewer can act on in one glance),
 *  hash-only mismatches after (they still need a real diff tool, not
 *  anything this function can show). */
export function formatReport(report) {
  if (report.ok) return `  ${report.name}: OK`;
  const lines = [`  ${report.name}: MISMATCH`];
  if (report.layerC) {
    for (const { key, before, after } of report.layerC.deltas) {
      lines.push(`    layerC.${key}: ${before} -> ${after}`);
    }
  }
  if (report.layerA) lines.push('    layerA: token-shape hash changed (structural -- run with a real diff tool on the rendered tokens to see what)');
  if (report.layerB) lines.push('    layerB: normalized-HTML hash changed (sample below)\n' +
    `      stored: ${JSON.stringify(report.layerB.storedSample)}\n` +
    `      fresh:  ${JSON.stringify(report.layerB.freshSample)}`);
  return lines.join('\n');
}
