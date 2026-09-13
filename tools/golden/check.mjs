// Regenerates every corpus document's snapshot fresh and compares it
// against the stored baseline (tools/golden/snapshots/) -- the CI/fast-tier
// path. Never writes anything; run tools/golden/update.mjs once you've
// confirmed a reported diff is an intended change, not a regression.
//
//   node tools/golden/check.mjs                  Layers A+B only
//   node tools/golden/check.mjs --with-layer-c    also Layer C (needs a
//                                                  built out/MDView.debug.exe)
//
// Exit code: 0 if every document matches its stored snapshot, 1 otherwise
// (including a document with no stored snapshot yet at all -- run
// tools/golden/update.mjs first).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  loadManifest, buildSnapshot, readStoredSnapshot, compareSnapshot, formatReport,
  corpusDir, defaultExePath,
} from './snapshot.mjs';

async function main() {
  const withLayerC = process.argv.includes('--with-layer-c');
  let exePath;
  if (withLayerC) {
    exePath = defaultExePath;
    if (!existsSync(exePath)) {
      console.error(`--with-layer-c needs a built debug exe at ${exePath} -- run: .\\build.ps1 -Debug`);
      process.exit(1);
    }
  }

  const manifest = await loadManifest();
  const reports = [];
  for (const [name, meta] of Object.entries(manifest.docs)) {
    const docPath = path.join(corpusDir, meta.file);
    const text = await readFile(docPath, 'utf-8');
    const stored = await readStoredSnapshot(name);
    if (!stored) {
      reports.push({ name, ok: false, missing: true });
      continue;
    }
    const fresh = await buildSnapshot(name, text, docPath, { exePath });
    reports.push(compareSnapshot(name, stored, fresh));
  }

  console.log('golden:check');
  for (const r of reports) {
    console.log(r.missing
      ? `  ${r.name}: NO STORED SNAPSHOT -- run: node tools/golden/update.mjs`
      : formatReport(r));
  }

  const failures = reports.filter((r) => !r.ok).length;
  console.log(`\n${reports.length} documents, ${failures} mismatch${failures === 1 ? '' : 'es'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
