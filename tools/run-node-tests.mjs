// `node --test <directory>` doesn't reliably discover test files on this
// platform/Node combination (Node 22.17 on Windows, ESM package.json) --
// verified directly: even `node --test tests/node` fails with a plain
// MODULE_NOT_FOUND against the literal directory path, as if directory-mode
// discovery never engaged. Passing explicit file paths works, so this globs
// them itself (fs.globSync, no dependency) and spawns the real test runner
// with an explicit file list -- portable across how this project's npm
// scripts actually run on Windows (cmd.exe, no shell glob expansion).
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = globSync('tests/node/**/*.test.mjs');
if (files.length === 0) {
  console.log('No test files found under tests/node/**/*.test.mjs');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
