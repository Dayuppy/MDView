// Charts each corpus document's median time across every stored
// tools/bench/history/*.json entry -- a slow, gradual drift across many
// small increments can stay under tools/bench/compare.mjs's own
// one-shot-vs-baseline threshold on every single run (each individual step
// too small to flag) while still adding up to a real regression over time;
// this is what makes that visible. Purely a local, personal view --
// tools/bench/history/ itself is gitignored (machine-specific timing), so
// this only ever charts runs made on THIS machine.
//
//   node tools/bench/trend.mjs
//   node tools/bench/trend.mjs --doc=math

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const historyDir = path.join(__dirname, 'history');

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }));

  const files = (await readdir(historyDir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) {
    console.error('No tools/bench/history/*.json entries -- run tools/bench/run.mjs first.');
    process.exit(1);
  }

  const entries = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(historyDir, f), 'utf-8'))));
  const docNames = [...new Set(entries.flatMap((e) => Object.keys(e.results)))].filter((n) => !args.doc || n === args.doc);

  console.log(`bench:trend -- ${entries.length} runs, ${docNames.length} document(s)\n`);
  for (const name of docNames) {
    console.log(name + ':');
    for (const entry of entries) {
      const r = entry.results[name];
      if (!r) continue;
      console.log(`  ${entry.ranAt}  median=${r.median.toFixed(0).padStart(6)}ms  mad=${r.mad.toFixed(0).padStart(5)}ms`);
    }
    console.log('');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
