// Guards the in-page-assertion migration (docs/BACKLOG.md, tests/MIGRATION.md):
// for every row in MIGRATION.md's table marked "Migrated and deleted", confirms
// the target spec file actually contains AT LEAST as many `test(...)` calls as
// the row claims. Without this, a migration commit could silently under-count
// (a copy-paste slip, a case quietly dropped while translating the table) and
// nothing would ever notice -- the native suite's own "failures=0" check has
// no expected-count baked in, by design (so a smaller debugRunEditorTest() is
// always a "pass"), which is exactly the gap this closes on the Playwright side.
//
//   node tools/check-parity.mjs        (exit 0 = ok, 1 = mismatch found)

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const ROW_RE = /^\|\s*(.+?)\s*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|$/gm;

function countSpecsRecursive(suite) {
  let n = (suite.specs || []).length;
  for (const child of suite.suites || []) n += countSpecsRecursive(child);
  return n;
}

// Actually RESOLVES the spec file through Playwright's own test collector
// (`--list --reporter=json`) rather than grepping source for `test(` calls --
// a data-driven `for (...) { test(...) }` loop (e.g. toolbar.spec.mjs, one
// TEST() call in source producing 31 real tests) makes a static count of
// literal call sites meaningless. This asks Playwright the same question a
// real run would answer.
function countResolvedTests(specPath) {
  // Playwright's file-argument matching treats the argument as a
  // regex/substring against each resolved test file's path, NOT a literal
  // filesystem path -- an absolute Windows path (backslashes and all)
  // doesn't match anything and silently returns zero tests. The basename is
  // enough to uniquely match one file in this project's flat tests/specs/.
  const basename = path.basename(specPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = execFileSync(
    process.execPath,
    [path.join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--list', '--reporter=json', basename],
    { cwd: root, encoding: 'utf-8' },
  );
  const report = JSON.parse(out);
  if (report.errors && report.errors.length) {
    throw new Error(`playwright --list failed for ${specPath}: ${report.errors.map((e) => e.message).join('; ')}`);
  }
  return report.suites.reduce((sum, s) => sum + countSpecsRecursive(s), 0);
}

async function main() {
  const migrationPath = path.join(root, 'tests', 'MIGRATION.md');
  const md = await readFile(migrationPath, 'utf-8');

  let problems = 0;
  let checked = 0;
  let rowMatch;
  while ((rowMatch = ROW_RE.exec(md))) {
    const [, section, specFile, expectedCountStr, status] = rowMatch;
    if (!/migrated and deleted/i.test(status)) continue; // only fully-landed rows are enforced
    checked++;
    const expected = Number(expectedCountStr);
    const specPath = path.join(root, specFile);
    if (!existsSync(specPath)) {
      console.error(`FAIL  ${section}: ${specFile} does not exist (MIGRATION.md claims ${expected} migrated tests here)`);
      problems++;
      continue;
    }
    const actual = countResolvedTests(specPath);
    if (actual < expected) {
      console.error(`FAIL  ${section}: MIGRATION.md claims ${expected} migrated tests in ${specFile}, found only ${actual}`);
      problems++;
    } else {
      console.log(`ok    ${section}: ${actual}/${expected} in ${specFile}`);
    }
  }

  if (checked === 0) {
    console.log('parity: no "Migrated and deleted" rows in tests/MIGRATION.md yet -- nothing to check');
  }
  if (problems > 0) {
    console.error(`\nparity: ${problems} row(s) failed.`);
    process.exit(1);
  }
  console.log(`\nparity: ${checked} row(s) checked, all ok.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
