// Regenerates every corpus document's golden snapshot and overwrites the
// stored baseline -- the deliberate-change path (a real renderer/markup
// update), not a check. See snapshot.mjs's own header for the file layout.
//
//   node tools/golden/update.mjs                  Layers A+B only
//   node tools/golden/update.mjs --with-layer-c    also Layer C (needs a
//                                                  built out/MDView.debug.exe)

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  loadManifest, buildSnapshot, writeSnapshot, findOrphanedSnapshots,
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
  const orphaned = await findOrphanedSnapshots(manifest);
  for (const name of orphaned) {
    console.log(`note: tools/golden/snapshots/${name}.json has no corresponding corpus doc anymore -- remove it by hand if it's really gone`);
  }

  for (const [name, meta] of Object.entries(manifest.docs)) {
    const docPath = path.join(corpusDir, meta.file);
    const text = await readFile(docPath, 'utf-8');
    const snapshot = await buildSnapshot(name, text, docPath, { exePath });
    await writeSnapshot(name, snapshot);
    console.log(`updated ${name}${snapshot.layerC ? ' (A+B+C)' : ' (A+B)'}`);
  }
  console.log(`\ngolden:update: ${Object.keys(manifest.docs).length} snapshots written to tools/golden/snapshots/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
