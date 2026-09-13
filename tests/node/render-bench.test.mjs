// Smoke-level: render-bench.mjs's actual value is the number it prints
// (verified by hand above), not something worth a golden-value test (real
// hardware speed varies) -- this just confirms it runs against the real
// corpus, produces the expected shape, and the --json flag writes a real,
// parseable file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const script = path.join(root, 'tools', 'bench', 'render-bench.mjs');

test('render-bench: runs against the real corpus and writes a well-formed JSON result', async () => {
  // Ensure the corpus exists (other tests/tools may have exercised
  // --force elsewhere in the same run; this only generates if missing).
  execFileSync(process.execPath, [path.join(root, 'tools', 'corpus', 'gen-corpus.mjs')], { cwd: root });

  const jsonRelPath = 'out/render-bench-test-result.json';
  const jsonPath = path.join(root, jsonRelPath);
  await rm(jsonPath, { force: true });

  const stdout = execFileSync(
    process.execPath,
    [script, '--iterations=2', `--json=${jsonRelPath}`],
    { cwd: root, encoding: 'utf-8' },
  );
  assert.match(stdout, /render-bench: \d+ docs, 2 iterations each/);

  const result = JSON.parse(await readFile(jsonPath, 'utf-8'));
  assert.equal(typeof result.corpusVersion, 'string');
  assert.equal(result.iterations, 2);
  assert.ok(Object.keys(result.results).length >= 8, 'every corpus document should have a result');
  for (const [name, r] of Object.entries(result.results)) {
    assert.ok(r.min >= 0, `${name}.min must be a non-negative number`);
    assert.ok(r.median >= r.min, `${name}.median must be >= min`);
    assert.ok(r.mad >= 0, `${name}.mad must be non-negative`);
  }

  await rm(jsonPath, { force: true });
});
