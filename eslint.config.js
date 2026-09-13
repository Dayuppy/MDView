// ESLint 9 flat config -- bug-finding rules only (docs/BACKLOG.md's tooling
// item). Deliberately NOT stylistic: no Prettier, no formatting rules, no
// opinionated style enforcement. assets/app.js is 4400+ lines with
// deliberate comment alignment a reformatter would destroy, and this
// project's own convention is "a script that does a job repeatably", not
// "a style every contributor must match" -- see build.ps1/CLAUDE.md for the
// same philosophy applied elsewhere.
//
//   npx eslint .            (or: npm run lint, once wired into check-*)

import js from '@eslint/js';
import globals from 'globals';

// Every vendor global assets/app.js, assets/md-setup.js, and assets/worker.js
// reference, spelled out explicitly rather than disabling no-undef for
// them -- so a genuine typo'd reference (e.g. `markdownIt` instead of
// `markdownit`) still gets caught. Cross-checked directly against
// assets/index.html's <script src="vendor/..."> list and worker.js's own
// importScripts() list, not assumed from each library's own docs.
const vendorGlobals = {
  markdownit: 'readonly',
  markdownitFootnote: 'readonly',
  markdownitDeflist: 'readonly',
  markdownitTaskLists: 'readonly',
  markdownItAnchor: 'readonly',   // capital I -- a real UMD-name inconsistency in this package
  markdownitSub: 'readonly',
  markdownitSup: 'readonly',
  markdownitMark: 'readonly',
  markdownitIns: 'readonly',
  markdownitAbbr: 'readonly',
  markdownitEmoji: 'readonly',
  katex: 'readonly',
  texmath: 'readonly',
  hljs: 'readonly',
  DOMPurify: 'readonly',
  mermaid: 'readonly',
  TurndownService: 'readonly',
  turndownPluginGfm: 'readonly',
};

export default [
  js.configs.recommended,

  // Shared bug-finding rules on top of eslint:recommended -- named
  // explicitly in docs/BACKLOG.md's own tooling item, plus a few more in
  // the same spirit (real correctness bugs, not style).
  {
    rules: {
      // caughtErrors: 'none' -- this codebase has dozens of deliberate
      // `catch (e) { /* expected, ignore */ }` sites (an unrecognized
      // highlight.js language, a console-forwarder that must never itself
      // throw, ...); the unused binding is the whole point, not an oversight.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // allowEmptyCatch -- same reasoning: an intentionally-empty catch body
      // for an expected, already-handled-by-doing-nothing failure is a
      // pattern, not a bug, in this specific codebase.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-binary-expression': 'error',
      'require-atomic-updates': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'array-callback-return': 'error',
    },
  },

  // The shipped app: one shared config object literal (rules above)
  // wouldn't otherwise know about vendor globals or the browser/worker
  // environment, so those live here instead.
  {
    files: ['assets/app.js', 'assets/boot.js', 'assets/md-setup.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...vendorGlobals },
    },
  },
  {
    files: ['assets/worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.worker, ...vendorGlobals, importScripts: 'readonly' },
    },
  },

  // Dev/test tooling: real Node ESM. Also includes browser globals -- both
  // tools/dev/serve.mjs (Playwright automation) and every tests/specs/*.spec
  // .mjs file embed literal callback bodies (page.evaluate(() => document...),
  // dispatched PointerEvents, ...) that ESLint statically sees as plain JS
  // in a Node file, but which actually execute in the browser at runtime --
  // a well-known false-positive category for linting Playwright test code.
  {
    files: ['tools/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // Playwright's own fixture API requires an empty {} first parameter for a
  // fixture with no dependencies -- not a mistake to flag.
  {
    files: ['tests/harness/fixtures.mjs'],
    rules: { 'no-empty-pattern': 'off' },
  },

  {
    ignores: [
      'assets/vendor/**',
      'sdk/**',
      'out/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'tools/test-textio.cpp',
    ],
  },
];
