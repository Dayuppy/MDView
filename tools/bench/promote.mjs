// Promotes a tools/bench/run.mjs result to become the new committed
// tools/bench/baseline.json -- the deliberate step after a real,
// intentional performance change lands (or before the very first
// baseline exists at all). Never automatic: tools/bench/compare.mjs only
// ever reads baseline.json, it's this script alone that overwrites it.
//
//   node tools/bench/promote.mjs                  promotes the LATEST history entry
//   node tools/bench/promote.mjs --file=tools/bench/history/<name>.json

import { readFile, writeFile, readdir } from 'node:fs/promises';
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

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }));

  const sourceFile = args.file ? path.resolve(root, args.file) : await latestHistoryFile();
  if (!sourceFile) {
    console.error('No tools/bench/history/*.json entries -- run tools/bench/run.mjs first.');
    process.exit(1);
  }

  const entry = JSON.parse(await readFile(sourceFile, 'utf-8'));
  await writeFile(baselinePath, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
  console.log(`promoted ${path.relative(root, sourceFile)} -> ${path.relative(root, baselinePath)}`);
  console.log('Commit tools/bench/baseline.json -- it\'s the shared reference point tools/bench/compare.mjs checks against.');
}

main().catch((err) => { console.error(err); process.exit(1); });
