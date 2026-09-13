// The corpus generator's ONE load-bearing property is determinism -- every
// benchmark baseline and golden snapshot in this project assumes a document
// generated today matches one generated months from now. That gets its own
// direct test, plus the skip-existing/--force contract profile-run.ps1 and
// the golden layer both rely on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..', '..');
const genScript = path.join(root, 'tools', 'corpus', 'gen-corpus.mjs');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

async function withCorpusDir(fn) {
  // The generator hardcodes out/corpus relative to the repo root rather than
  // accepting a directory argument, so exercise it against the real out/
  // dir but through a throwaway HOME... actually simplest: just run it
  // against the real repo (it's designed to be idempotent/safe to run
  // repeatedly) and inspect out/corpus directly. A temp-dir sandbox isn't
  // worth the complexity here since the generator has no side effects
  // beyond writing into out/corpus, which is already gitignored scratch
  // space by design.
  const outDir = path.join(root, 'out', 'corpus');
  await fn(outDir);
}

test('gen-corpus: --force twice produces byte-identical output (determinism)', async () => {
  await withCorpusDir(async (outDir) => {
    execFileSync(process.execPath, [genScript, '--force'], { cwd: root });
    const manifest1 = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf-8'));

    execFileSync(process.execPath, [genScript, '--force'], { cwd: root });
    const manifest2 = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf-8'));

    assert.equal(manifest1.corpusVersion, manifest2.corpusVersion);
    for (const name of Object.keys(manifest1.docs)) {
      assert.equal(manifest1.docs[name].sha256, manifest2.docs[name].sha256, `${name} must be byte-identical across regenerations`);
    }
  });
});

test('gen-corpus: without --force, an existing file is kept, not silently changed', async () => {
  await withCorpusDir(async (outDir) => {
    execFileSync(process.execPath, [genScript, '--force'], { cwd: root });
    const tinyPath = path.join(outDir, 'tiny.md');
    const tampered = '# Tampered\n\nSomeone wrote a real file here by hand.\n';
    await writeFile(tinyPath, tampered, 'utf-8');

    execFileSync(process.execPath, [genScript], { cwd: root }); // no --force

    const stillTampered = await readFile(tinyPath, 'utf-8');
    assert.equal(stillTampered, tampered, 'a pre-existing file must survive a non-forced run untouched');

    // Restore real generated content for any other test/tool that expects it.
    execFileSync(process.execPath, [genScript, '--force'], { cwd: root });
  });
});

test('gen-corpus: manifest sha256 values actually match the written file contents', async () => {
  await withCorpusDir(async (outDir) => {
    execFileSync(process.execPath, [genScript, '--force'], { cwd: root });
    const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf-8'));
    for (const [name, meta] of Object.entries(manifest.docs)) {
      const content = await readFile(path.join(outDir, meta.file), 'utf-8');
      assert.equal(sha256(content), meta.sha256, `${name}'s manifest sha256 must match its real file content`);
      assert.equal(Buffer.byteLength(content, 'utf-8'), meta.bytes, `${name}'s manifest byte count must match`);
    }
  });
});
