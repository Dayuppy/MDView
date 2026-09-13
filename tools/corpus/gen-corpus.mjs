// Deterministic benchmark/golden-fixture corpus generator. Seeded (xorshift32,
// no external dependency, no Math.random, no dates) so a document generated
// today is byte-identical to one generated in six months on another machine
// -- a number measured against `mixed.md` stays comparable across time, and
// a golden snapshot of it never spuriously drifts. Fixes profile-run.ps1's
// dead hardcoded -CorpusDir default, which pointed at a since-deleted
// session-specific scratchpad path with no generator behind it at all.
//
//   node tools/corpus/gen-corpus.mjs             (writes out/corpus/*, skips existing)
//   node tools/corpus/gen-corpus.mjs --force      (regenerates everything)

import { writeFile, mkdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const outDir = path.join(root, 'out', 'corpus');

// --- deterministic PRNG -----------------------------------------------------

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xFFFFFFFF;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function int(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }

const WORDS = ('the quick brown fox jumps over lazy dog markdown viewer render document ' +
  'heading table code block footnote reference link image accessible keyboard focus ' +
  'window native bridge worker chunk parser token stream sanitize decorate progressive ' +
  'watcher reload dirty editing toolbar action undo stack selection caret').split(' ');

function sentence(rng, n = int(rng, 6, 14)) {
  const words = Array.from({ length: n }, () => pick(rng, WORDS));
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ') + '.';
}
function paragraph(rng, sentences = int(rng, 2, 5)) {
  return Array.from({ length: sentences }, () => sentence(rng)).join(' ');
}

// --- document builders -------------------------------------------------------

function genTiny(rng) {
  return `# Tiny\n\n${paragraph(rng, 2)}\n`;
}

function genMixed(rng, targetHeadings = 12) {
  const out = ['# Mixed Corpus Document\n'];
  for (let h = 1; h <= targetHeadings; h++) {
    const level = Math.min(4, int(rng, 1, 3));
    out.push(`${'#'.repeat(level)} Section ${h}\n`);
    out.push(paragraph(rng) + '\n');
    if (h % 4 === 0) {
      out.push('| Col A | Col B | Col C |\n| --- | --- | --- |\n' +
        Array.from({ length: 3 }, () => `| ${pick(rng, WORDS)} | ${int(rng, 0, 999)} | ${pick(rng, WORDS)} |`).join('\n') + '\n');
    }
    if (h % 5 === 0) {
      out.push('```js\nfunction f' + h + '(x) {\n  return x * ' + int(rng, 2, 9) + ';\n}\n```\n');
    }
    if (h % 6 === 0) {
      out.push(`Inline math $x^${int(rng, 2, 5)} + y = z$ and a [link](https://example.com/${h}).\n`);
    }
    if (h % 8 === 0) {
      out.push('```mermaid\ngraph TD\n  A[Start] --> B[Step ' + h + ']\n  B --> C[End]\n```\n');
    }
  }
  return out.join('\n');
}

function genCode(rng, blocks = 60) {
  const langs = ['js', 'powershell', 'dockerfile', 'cmake', 'nginx', 'plaintext'];
  const out = ['# Code-Heavy Document\n'];
  for (let i = 0; i < blocks; i++) {
    out.push(`## Snippet ${i + 1}\n`);
    const lang = pick(rng, langs);
    const lines = Array.from({ length: int(rng, 3, 10) }, () => `  line_${int(rng, 0, 9999)} = ${int(rng, 0, 999)};`);
    out.push('```' + lang + '\n' + lines.join('\n') + '\n```\n');
  }
  return out.join('\n');
}

function genMath(rng, blocks = 80) {
  const out = ['# Math-Heavy Document\n'];
  for (let i = 0; i < blocks; i++) {
    out.push(`## Formula ${i + 1}\n`);
    out.push(`Inline: $a_${i}^2 + b_${i}^2 = c_${i}^2$\n`);
    out.push('$$\n\\sum_{k=1}^{' + int(rng, 5, 50) + '} k^2 = \\frac{n(n+1)(2n+1)}{6}\n$$\n');
  }
  return out.join('\n');
}

function genTables(rng, tableCount = 400) {
  // Mirrors tools/regression.ps1's own $largeDoc pattern (a top-referenced,
  // bottom-defined link + footnote, to exercise progressive-chunk-boundary
  // resolution), generalized into a reusable, seeded corpus document.
  const out = [
    '# Tables Corpus Document\n',
    'See the [top link][ref] and this footnote[^1] defined at the very end.\n',
  ];
  for (let t = 0; t < tableCount; t++) {
    const rows = int(rng, 2, 5);
    out.push(`## Table ${t + 1}\n`);
    out.push('| A | B | C |\n| --- | --- | --- |\n');
    for (let r = 0; r < rows; r++) {
      out.push(`| ${int(rng, 0, 99)} | ${pick(rng, WORDS)} | ${int(rng, 0, 99)} |`);
    }
    out.push('');
  }
  out.push('[ref]: https://example.com/ref');
  out.push('[^1]: A footnote defined at the very end of a large document.');
  return out.join('\n') + '\n';
}

function genMermaid(rng, diagrams = 30) {
  const out = ['# Mermaid-Heavy Document\n'];
  for (let i = 0; i < diagrams; i++) {
    out.push(`## Diagram ${i + 1}\n`);
    out.push('```mermaid\ngraph TD\n' +
      `  A${i}[Start] --> B${i}{Decision ${i}}\n` +
      `  B${i} -->|yes| C${i}[Do it]\n` +
      `  B${i} -->|no| D${i}[Skip]\n` +
      '```\n');
  }
  return out.join('\n');
}

function genHuge(rng) {
  // A big multiplier on genMixed's shape -- specifically to force the
  // progressive/worker path and exercise chunking + memory at real scale.
  return genMixed(rng, 400);
}

function genPlain(rng) {
  // README's documented claim: "Non-Markdown text files render as plain
  // text." Deliberately markdown-LOOKING content in a .txt file.
  return `# This looks like a heading\n\n**bold** text and a [link](https://example.com)\n\n${paragraph(rng)}\n`;
}

const DOCS = [
  { name: 'tiny', ext: 'md', seed: 1, build: genTiny },
  { name: 'mixed', ext: 'md', seed: 2, build: (rng) => genMixed(rng, 12) },
  { name: 'code', ext: 'md', seed: 3, build: (rng) => genCode(rng, 60) },
  { name: 'math', ext: 'md', seed: 4, build: (rng) => genMath(rng, 80) },
  { name: 'tables', ext: 'md', seed: 5, build: (rng) => genTables(rng, 400) },
  { name: 'mermaid', ext: 'md', seed: 6, build: (rng) => genMermaid(rng, 30) },
  { name: 'huge', ext: 'md', seed: 7, build: genHuge },
  { name: 'plain', ext: 'txt', seed: 8, build: genPlain },
];

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function main() {
  const force = process.argv.includes('--force');
  await mkdir(outDir, { recursive: true });

  const manifest = { generatedBy: 'tools/corpus/gen-corpus.mjs', docs: {} };
  for (const doc of DOCS) {
    const filePath = path.join(outDir, `${doc.name}.${doc.ext}`);
    if (!force && await exists(filePath)) {
      const existing = await readFile(filePath, 'utf-8');
      manifest.docs[doc.name] = { file: `${doc.name}.${doc.ext}`, bytes: Buffer.byteLength(existing, 'utf-8'), sha256: sha256(existing), regenerated: false };
      continue;
    }
    const text = doc.build(makeRng(doc.seed));
    await writeFile(filePath, text, 'utf-8');
    manifest.docs[doc.name] = { file: `${doc.name}.${doc.ext}`, bytes: Buffer.byteLength(text, 'utf-8'), sha256: sha256(text), regenerated: true };
    console.log(`wrote ${doc.name}.${doc.ext}  ${manifest.docs[doc.name].bytes} bytes`);
  }
  // A corpus-version hash: baselines record this, so a corpus change
  // invalidates a stale comparison loudly instead of silently shifting the
  // numbers being compared.
  manifest.corpusVersion = sha256(Object.values(manifest.docs).map((d) => d.sha256).join(''));
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`manifest.json written, corpusVersion=${manifest.corpusVersion.slice(0, 12)}`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

main().catch((err) => { console.error(err); process.exit(1); });
