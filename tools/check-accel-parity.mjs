// Guards docs/BACKLOG.md's hygiene note: the set of keyboard combos native
// owns (src/main.cpp's HandleAccelerator()) is duplicated in assets/app.js's
// keydown handler, which swallows the same combos so they don't ALSO fire as
// ordinary page-level keystrokes once WebView2 forwards the accelerator
// event. The two lists have no structural link -- edit one without the
// other and nothing would notice until a real user hit a key that either
// double-fires (JS forgot to swallow a combo native owns) or silently stops
// doing its normal thing for no reason (JS swallows a combo native no longer
// owns). This parses both real source files (not a hand-maintained copy of
// either list) and diffs the sets.
//
//   node tools/check-accel-parity.mjs        (exit 0 = ok, 1 = mismatch found)

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Special (non-letter, non-digit) Ctrl combos: each VK_* token in main.cpp's
// HandleAccelerator() maps to one or more possible `e.key` values app.js
// must swallow, since a physical key's e.key can vary by shift state (the
// same key that types '=' unshifted types '+' shifted) in a way a single VK
// code doesn't capture. This table IS the intended contract -- both sides
// are checked against it, in both directions.
const OEM_MAP = {
  VK_OEM_COMMA: [','],
  'VK_OEM_PLUS|VK_ADD': ['+', '='],
  'VK_OEM_MINUS|VK_SUBTRACT': ['-'],
};

function extractFunctionBody(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  // Walk brace depth from the signature's own opening '{' to find the
  // matching close -- robust to the function growing new blocks inside it,
  // unlike a fixed end-marker string.
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function body: ${signature}`);
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function diff(a, b) {
  return [...a].filter((x) => !b.has(x));
}

async function main() {
  const mainCpp = await readFile(path.join(root, 'src', 'main.cpp'), 'utf-8');
  const appJs = await readFile(path.join(root, 'assets', 'app.js'), 'utf-8');

  const accelFn = extractFunctionBody(mainCpp, 'static bool HandleAccelerator(UINT vk) {');

  // Ctrl-owned single-char combos: every `case 'X':` in the function is a
  // Ctrl+X (or Ctrl+Shift+X) combo, including the digit '0' (zoom reset).
  const cppCtrlChars = new Set(
    [...accelFn.matchAll(/case\s+'([A-Za-z0-9])'\s*:/g)].map((m) => m[1].toLowerCase()),
  );
  const expectedJsCtrlKeys = new Set(cppCtrlChars);
  const oemProblems = [];
  for (const [vkTokens, jsChars] of Object.entries(OEM_MAP)) {
    const tokens = vkTokens.split('|');
    const present = tokens.some((t) => accelFn.includes(t));
    if (!present) { oemProblems.push(`main.cpp no longer has any of [${vkTokens}] -- update OEM_MAP or the accelerator switch`); continue; }
    for (const c of jsChars) expectedJsCtrlKeys.add(c);
  }

  // app.js's ctrl-combo swallow list: the literal array right after
  // `e.ctrlKey && !e.altKey &&`.
  const ctrlListMatch = appJs.match(/e\.ctrlKey\s*&&\s*!e\.altKey\s*&&\s*\[([^\]]*)\]\.includes\(k\)/);
  if (!ctrlListMatch) throw new Error('could not find the Ctrl-combo swallow list in assets/app.js');
  const jsCtrlKeys = new Set(
    [...ctrlListMatch[1].matchAll(/'([^']*)'/g)].map((m) => m[1].toLowerCase()),
  );

  // Non-ctrl/non-alt bare function keys: `case VK_F<n>:` in the same function.
  const cppFKeys = new Set([...accelFn.matchAll(/case\s+VK_(F\d+)\s*:/g)].map((m) => m[1]));
  const fkeyListMatch = appJs.match(/!e\.ctrlKey\s*&&\s*!e\.altKey\s*&&\s*\[([^\]]*)\]\.includes\(e\.key\)/);
  if (!fkeyListMatch) throw new Error('could not find the bare-function-key swallow list in assets/app.js');
  const jsFKeys = new Set([...fkeyListMatch[1].matchAll(/'([^']*)'/g)].map((m) => m[1]));

  let problems = oemProblems.length;
  for (const p of oemProblems) console.error(`FAIL  ${p}`);

  if (!setsEqual(expectedJsCtrlKeys, jsCtrlKeys)) {
    problems++;
    const missingFromJs = diff(expectedJsCtrlKeys, jsCtrlKeys);
    const extraInJs = diff(jsCtrlKeys, expectedJsCtrlKeys);
    console.error('FAIL  Ctrl-combo lists disagree between main.cpp (HandleAccelerator) and app.js (keydown handler):');
    if (missingFromJs.length) console.error(`      app.js is missing (native owns these, would double-fire): ${missingFromJs.join(', ')}`);
    if (extraInJs.length) console.error(`      app.js swallows extra keys native does NOT own (silently breaks their normal behavior): ${extraInJs.join(', ')}`);
  } else {
    console.log(`ok    Ctrl-combo list: ${jsCtrlKeys.size} keys agree (${[...jsCtrlKeys].sort().join(' ')})`);
  }

  if (!setsEqual(cppFKeys, jsFKeys)) {
    problems++;
    const missingFromJs = diff(cppFKeys, jsFKeys);
    const extraInJs = diff(jsFKeys, cppFKeys);
    console.error('FAIL  Bare function-key lists disagree between main.cpp (HandleAccelerator) and app.js (keydown handler):');
    if (missingFromJs.length) console.error(`      app.js is missing: ${missingFromJs.join(', ')}`);
    if (extraInJs.length) console.error(`      app.js has extra: ${extraInJs.join(', ')}`);
  } else {
    console.log(`ok    Function-key list: ${jsFKeys.size} keys agree (${[...jsFKeys].sort().join(' ')})`);
  }

  if (problems > 0) {
    console.error(`\naccel-parity: ${problems} problem(s) found.`);
    process.exit(1);
  }
  console.log('\naccel-parity: ok.');
}

main().catch((err) => { console.error(err); process.exit(1); });
