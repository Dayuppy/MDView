// Loads the REAL, unmodified markdown pipeline (assets/md-setup.js + every
// vendored library assets/worker.js also loads) into a Node `vm` context --
// no browser, no exe, ~200ms for the whole corpus. md-setup.js is DOM-free
// by construction (its own header comment says so), which is what makes
// this possible at all.
//
// Deliberately does NOT define `module`/`exports`/`define` in the context,
// so every vendored UMD library takes its plain-browser-global branch --
// exactly the branch index.html/worker.js also get, so this is loading the
// same code path, not a different one. `self` is bound to the context's own
// globalThis, matching how md-setup.js addresses everything ("self.markdownit",
// "self.mdvCreateRenderer", ...).

import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, '..', '..', 'assets');
const vendorDir = path.join(assetsDir, 'vendor');

// Same load order as assets/worker.js's importScripts() list (assets/worker.js:15-38) --
// the one place in the real app that loads every one of these together.
const VENDOR_FILES = [
  'markdown-it.min.js',
  'markdown-it-footnote.min.js',
  'markdown-it-deflist.min.js',
  'markdown-it-task-lists.min.js',
  'markdown-it-anchor.umd.min.js',
  'markdown-it-sub.min.js',
  'markdown-it-sup.min.js',
  'markdown-it-mark.min.js',
  'markdown-it-ins.min.js',
  'markdown-it-abbr.min.js',
  'markdown-it-emoji.min.js',
  'katex.min.js',
  'mhchem.min.js',
  'texmath.min.js',
  'highlight.min.js',
  'lang-powershell.min.js',
  'lang-dos.min.js',
  'lang-dockerfile.min.js',
  'lang-cmake.min.js',
  'lang-x86asm.min.js',
  'lang-nginx.min.js',
];

// Caches the in-flight PROMISE, not the resolved value -- if two callers
// invoke loadRenderer() concurrently before the first has finished (e.g.
// Promise.all-style parallel golden-snapshot generation), a plain
// `if (cachedContext) return cachedContext;` guard doesn't help, since
// cachedContext is still null for both at that point: both would build a
// full, separate vm context, and whichever finished last would silently win
// -- two coexisting renderer instances for a brief window, and wasted work,
// exactly what render-node.test.mjs's "caches -- returns the identical
// instance" check exists to guard against. Memoizing the promise instead
// means every concurrent caller awaits the same one build.
let cachedContextPromise = null;

/** Builds (once, cached) a vm context with the real renderer loaded, and
 *  returns { md, mdvChunkTokens, mdvSplitFrontMatter } -- the same objects
 *  assets/worker.js constructs for itself. */
export function loadRenderer() {
  if (!cachedContextPromise) cachedContextPromise = buildRenderer();
  return cachedContextPromise;
}

async function buildRenderer() {
  const sandbox = {};
  sandbox.self = sandbox; // md-setup.js and every vendor UMD addresses `self`
  sandbox.console = console;
  // Explicitly no `module`/`exports`/`define`/`window` -- absence is what
  // forces each UMD bundle onto its plain-global branch.
  const context = vm.createContext(sandbox);

  for (const file of VENDOR_FILES) {
    const src = await readFile(path.join(vendorDir, file), 'utf-8');
    new vm.Script(src, { filename: 'vendor/' + file }).runInContext(context);
  }
  const mdSetupSrc = await readFile(path.join(assetsDir, 'md-setup.js'), 'utf-8');
  new vm.Script(mdSetupSrc, { filename: 'md-setup.js' }).runInContext(context);

  if (typeof sandbox.mdvCreateRenderer !== 'function') {
    throw new Error('md-setup.js did not define self.mdvCreateRenderer after loading vendor files -- ' +
      'a UMD library likely took its module/exports branch instead of the plain-global one.');
  }

  const md = sandbox.mdvCreateRenderer();
  return {
    md,
    mdvChunkTokens: sandbox.mdvChunkTokens,
    mdvSplitFrontMatter: sandbox.mdvSplitFrontMatter,
    sandbox,
  };
}

/** Parses `text` into markdown-it's real token stream (env populated exactly
 *  as md.parse() does in production -- reference/footnote definitions etc). */
export async function parseToTokens(text) {
  const { md } = await loadRenderer();
  const env = {};
  const tokens = md.parse(text, env);
  return { tokens, env };
}

/** Renders `text` to HTML through the real renderer (single-pass, matching
 *  the sync render path -- not the progressive/chunked one). */
export async function renderHtml(text) {
  const { md } = await loadRenderer();
  const env = {};
  return md.render(text, env);
}
