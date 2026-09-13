# Changelog

One line per landed change, newest first. Detail lives in the commit message.

## Unreleased

- Prepare for public distribution: add an MIT `LICENSE`, and use `git filter-repo` to strip the
  repeatedly-recommitted `out/MDView.exe`/`out/MDView.debug.exe` build artifacts from all git
  history (94 MB → 13 MB `.git`; pruned ~13 now-empty "Rebuild the release exe" commits along with
  them). Both exes are now `.gitignore`d — `build.ps1` produces one locally, matching how `sdk/`
  and `assets/vendor/` were already handled (vendored source, never a committed build output).
  Rewrites every commit hash in this repository's history; safe since no remote existed yet for
  anyone else to have a stale clone of.

- Convert `tools/regression.ps1` into a named scenario registry: all 37 scenarios are now
  independently invokable (`-List` to enumerate, `-Only`/`-Skip` comma-separated to run a subset,
  `-ResultsJson` for per-scenario name/checks/failed/ms). No parameters still runs everything, in
  the same order, exactly like the old unconditional script (verified: identical 178/178 pass
  count). Each scenario is dot-sourced (not called) by a CLI driver, so cross-scenario variable
  visibility (e.g. the teardown reading scenario 10's `$travTargetDir`) needed zero changes.
  Converted via a small one-off Node script rather than by hand, given the size (~1300 lines) --
  caught three real issues along the way: a here-string's body/closing delimiter must never be
  reindented (PowerShell requires `'@` at column 0; reindenting would also have silently changed
  the literal Markdown test content), a generic `$sw` name collided between the driver's own
  timer and the log-rotate scenario's unrelated `StreamWriter` of the same name (fixed with
  `Get-Date` timestamps instead of a shared Stopwatch object), and the teardown crashed on `-Only`
  runs that left scenario 10 (which sets `$travTargetDir`) out, since `Remove-Item -Path $null` is
  a terminating parameter-binding error even with `-ErrorAction SilentlyContinue` on the same
  call. `-Parallel` deliberately excluded: needs its own work-dir isolation first, since every
  scenario still shares one scratch directory.
- Add session restore: an opt-in "Reopen last document on launch" toggle (Aa panel, defaults off)
  reopens `S.recent[0]` when the app starts with nothing else to show. Implemented JS-side
  (`assets/app.js`) rather than teaching native to parse the settings blob's `recent` field itself
  -- reuses the exact `openPath` message a recent-files click already sends. Resolves the plan's
  last open architectural question: an explicit CLI file argument always wins (native's
  `BuildBootScript()` now exposes a `hasDoc` boot flag), only the solo/first instance restores
  (a new `solo` boot flag mirroring `g_solo`), and scroll position comes back for free via the
  existing path-keyed `S.positions`. The restore's `openPath` posts *before* `ready`, not after,
  so native's `ready` handler already has `g_haveDoc` set by the time it runs -- otherwise every
  restored launch would flash the "Welcome" screen first, since native's `ready` handler replies
  `nodoc` whenever no document is open yet at that exact instant. `OpenDocument()` also gained a
  debug-only `"opened: <path> nav=<nav>"` log line, letting `tools/regression.ps1`'s new scenario
  prove the real exe's restore path fires end to end. Verified discriminating power by disabling
  the restore condition and confirming the Playwright suite's positive-case test failed.
- Add true PDF export via WebView2's native `ICoreWebView2_7::PrintToPdf` COM API, completing
  the Export feature and resolving the plan's own open architectural question about it.
  `PrintToPdf` is genuinely async (a completion handler, not a direct return) -- fits the existing
  generic `MakeCB<TIface, TArg1, TArg2>` callback helper (`src/main.cpp`, already used for
  environment/controller creation) rather than needing an ad-hoc pattern. No page-built payload
  needed (unlike HTML export): native's own print pipeline renders whatever's currently shown,
  the same one `Ctrl+P` already reaches via the OS print dialog, so it gets the existing
  `@media print` CSS rules (chrome hidden, `#content` forced visible) for free. New "Export as
  PDF…" menu item; `--mdv-pdf-test` (mirrors `--mdv-export-test`) proves the write side directly
  since a real file-save dialog can't be driven headlessly; its `tools/regression.ps1` scenario
  needs a longer `--mdv-exit-after` than the shared 800ms default, since the completion fires
  later on the same message loop, not synchronously. Verified discriminating power by skipping
  the real `PrintToPdf` call and confirming both the completion-log and file-existence checks
  failed, then restoring.
- Embed KaTeX's CSS + fonts into the HTML export so math renders properly styled instead of
  unstyled/broken-looking spans. `buildKatexEmbedCss()` (`assets/app.js`) fetches
  `vendor/katex.min.css` and its referenced woff2 font files at export time -- only when the
  document actually contains math (`content.querySelector('.katex')`), since a document with none
  would otherwise carry ~300KB of embedded font data it never uses -- and rewrites each
  `@font-face`'s multi-format `src` list down to one embedded base64 data URI (the vendored CSS's
  own `.woff`/`.ttf` fallback urls point at files that were never actually vendored). Both
  `buildStandaloneHtml()` and `exportHtml()` are now async as a result; updated
  `tests/specs/export.spec.mjs`'s existing test to poll for the outbound message rather than
  assume it's already landed the instant the menu click resolves, matching the same pattern
  `copyAsRichText()`'s test already used for its own async gap. New
  `tests/specs/katex-embed.spec.mjs` covers both the math and no-math cases. Verified
  discriminating power by disabling the embedding step and confirming only the math-doc test
  failed.
- Add `tools/run-checks.mjs`, the unified check entry point (`npm run check` / `check:full`).
  Orchestrates every other check tool in this repo rather than replacing any of them: `npm run
  check` (fast tier -- lint, parity, accel-parity, node tests, golden A+B, Playwright, render
  bench; ~35s measured, a bit over the original ~25s aspiration, mostly `npx` subprocess-spawn
  overhead) and `npm run check:full` (adds the debug build, `test-textio`, golden C, the exe
  regression suite, exe bench + baseline compare, and a `tasklist` check for leftover `MDView*`
  processes). Every step runs to completion regardless of earlier failures, so one broken check
  never hides another -- a final summary lists exactly which steps failed. Verified
  discriminating power with a real syntax error: `lint` and `playwright` correctly failed (the
  served `app.js` broke, so no page ever gets `window.__MDV_TEST`) while every other fast-tier
  step still ran and correctly reported OK. Also re-promoted `tools/bench/baseline.json` from a
  clean 5-iteration run -- the `check:full` run that first exercised `bench:compare` for real
  correctly flagged 3 documents against the original baseline, which turned out to have been
  captured from an unusually noisy 2-iteration sample (one document's baseline median was itself
  a 17-second outlier); the noise-aware gate did exactly its job by surfacing that the baseline
  itself, not the code, was the problem.
- Add PSScriptAnalyzer for this project's PowerShell scripts -- `PSScriptAnalyzerSettings.psd1`
  (bug-finding rules only, same philosophy as `eslint.config.js`) + `tools/check-powershell.ps1`.
  Fixed two real findings: `$args` (PowerShell's own automatic variable) shadowed and immediately
  overwritten in both `regression.ps1` and `profile-run.ps1`'s exe-launch helpers (renamed to
  `$exeArgs` in both -- confirmed by grep that neither ever reads the original `$args`), and a
  genuinely unused `$soloB` process-object assignment in `regression.ps1`'s multi-instance
  scenario (the object itself was never read; only the two instances' log files are). Verified
  discriminating power by temporarily reintroducing the `$args` shadowing and confirming the
  check caught it, then restoring. Full native regression suite re-confirmed green after editing
  `tools/regression.ps1` itself.
- Complete the corpus+benchmarks tooling item: `tools/bench/run.mjs` (exe-level end-to-end
  bench -- real process launch, WebView2 controller creation, IPC; the pure-Node
  `render-bench.mjs` can't see any of that cost), `tools/bench/compare.mjs` (a noise-aware
  regression gate against the committed `tools/bench/baseline.json`, flagging only beyond
  `max(5%, 3×MAD)` -- real runs showed MAD in the thousands of ms for some documents, so a plain
  percentage gate would misfire constantly), `tools/bench/promote.mjs` (the deliberate
  baseline-update step), and `tools/bench/trend.mjs` (charts medians across local
  `tools/bench/history/`, gitignored -- machine-specific timing -- for a slow drift too small to
  trip any single compare). `npm run bench:exe`/`bench:compare`/`bench:promote`/`bench:trend`.
  Verified discriminating power on the noise gate (a synthetic regression on a low-noise document
  flagged; the same absolute shift on a high-noise document correctly didn't, gated by its own
  historical MAD).
- Add golden-snapshot Layers B and C, completing the golden-snapshot tooling item. Layer B
  (`tools/golden/layer-b.mjs`) normalizes rendered HTML for stable-but-meaningful diffs -- KaTeX
  subtrees collapse to their embedded TeX source, `hljs` spans stay untouched. Layer C
  (`tools/golden/layer-c.mjs`) captures the real exe's `debugDomSummary()` counters headlessly,
  replacing `tools/regression.ps1`'s hardcoded per-document magic numbers (e.g. `headings=17`)
  with a real, stored baseline that's diffed automatically instead of hand-maintained. Storage is
  one JSON file per corpus document under `tools/golden/snapshots/`; `npm run golden:update` /
  `npm run golden:check` (both Layer A+B by default, no exe needed; `--with-layer-c` adds the
  exe-backed layer). Review output is counter-deltas-first (`layerC.tables: 3 -> 0`, not just
  "changed"). Verified discriminating power on all three layers, including one check specifically
  proving Layer C catches a real `decorate()` regression (a disabled table-wrap step) that Layers
  A/B structurally cannot see, since they never run `decorate()` at all.
- Complete the `debugRunEditorTest()` migration, renaming it `debugRunNativeTest()` to match:
  every remaining section (decorate()'s `data-open` stripping, settings reset, `bindPref`/
  `syncA11yControls`, theme cycling, a11y/help panel focus-trap, zoom-toast dedup, undo-stack
  checks, `continueBlock()`/`tableTab()`/roving-tabindex, emoji + the CommonMark/GFM edge-case
  table (moved to `tests/node/render-node.test.mjs` — pure logic, no browser needed), DOMPurify
  URI-scheme checks, `insertImage` drop handling, `saveClipboardImage`'s malformed-base64
  rejection, and paste HTML→Markdown/Ctrl+Shift+V/URL-over-selection/sanitization) moved to
  dedicated `tests/specs/*.spec.mjs` files, designed by 13 parallel workflow agents and applied,
  verified, and discriminating-power-checked one at a time. Only genuinely native-only checks
  remain (`openExternal`/`__abs__`/`openPath` UNC defense-in-depth, `saveClipboardImage`'s
  real-file-write round trip). New test infra along the way: `FakeNative.insertImage()` (a
  native-initiated test-setup helper, mirroring `loadDoc()`), a `replaceS` `__MDV_TEST` hook, and
  several more exposed internals (`applyPrefs`, `openPanel`, `syncA11yControls`, `continueBlock`,
  `tableTab`, `replaceCurrent`, `collectMatches`, `findOpts`, `ensureTurndown`, `PURIFY_CFG`/
  `PURIFY_CFG_FRAGMENT`). Two real findings along the way: a Ctrl+Shift+V *real* Playwright
  keypress makes Chromium invoke its own native "paste without formatting" command, firing a
  second real paste event that silently eats the one-shot `plainPasteUntil` flag before the
  test's own synthetic paste runs (fixed by using a synthetic keydown instead, matching the
  original in-page test); and a zoom-toast-dedup test using `expect(locator).toBeHidden()`,
  which auto-retries long enough for the toast's own auto-hide timer to satisfy it regardless of
  whether the dedup guard actually fired (fixed with a direct one-shot read). Verified
  discriminating power on all 13 migrated sections. `tests/MIGRATION.md` is now just a short
  pointer to this changelog/`git log` for detail.
- Migrate `CMDS.newDoc`/`reloadRequest`/`openRequest`'s confirmDiscard-gated wiring out of
  `debugRunEditorTest()` -- `tests/specs/cmds-wiring.spec.mjs`. Uses `native.received`/
  `lastReceived()` for the message-type checks and a new read-only `pendingNewDoc` field on
  `__MDV_TEST.state`. Verified discriminating power on the decline path (temporarily made
  `newDoc()` ignore `confirmDiscard()`'s return value, confirmed the decline test failed because
  a `newDoc` message posted when it shouldn't have, restored).
- Migrate `saveDoc()`'s three early-return branches out of `debugRunEditorTest()` --
  `tests/specs/save-doc.spec.mjs`. The "non-file view" case loads the real feature-tour document
  via a genuine menu click rather than a synthetic `doc.kind` assignment (no hook existed for
  that anyway). Added `native.received` to `FakeNative` (a new array recording every inbound,
  page → native message) since simulated `saveDoc`/`saveAsDoc` handling is otherwise identical
  (both just echo `saved`), so the two aren't distinguishable via the existing outbound-only
  `sent` array alone -- a new `lastReceived()` helper on the test harness mirrors `lastSent()`.
  Verified discriminating power on the not-dirty early return.
- Migrate the menu Print/Show-in-Explorer actions and `confirmDiscard()` out of
  `debugRunEditorTest()`. Print/reveal drive real menu clicks (`tests/specs/menu-print-reveal.spec.mjs`);
  `native.sent`'s `__revealedInExplorer` echo (FakeNative's "record intent" convention) replaces
  the manual `bridge.postMessage` stub the original in-page test used. `confirmDiscard()`'s
  dirty-gated `window.confirm` is a real native dialog in a real browser context, handled through
  Playwright's `page.on('dialog')` API instead of monkey-patching `window.confirm`
  (`tests/specs/confirm-discard.spec.mjs`). Verified discriminating power on the not-dirty
  short-circuit.
- Migrate the application-menu keyboard nav / click-outside-to-close and lightbox focus-trap
  checks out of `debugRunEditorTest()`. The menu checks now drive the real UI (click `#btn-menu`,
  real keyboard/pointer events, `tests/specs/menu-keyboard-nav.spec.mjs`) since every path there is
  naturally reachable through ordinary interaction. The lightbox's Tab-trap moved the same way
  (`tests/specs/lightbox-focus-trap.spec.mjs`; the lightbox now has 6 real focusable controls, so
  no synthetic extra button is needed) -- except "closing returns focus to whatever opened it",
  which still drives `openLightbox`/`closeLightbox` directly (both newly exposed on `__MDV_TEST`):
  a real mouse click on `<img>` (no tabindex) blurs whatever was focused before the click handler
  even runs, so there's no meaningful focused "opener" observable through a real click. Verified
  discriminating power on the ArrowUp-wrap and Tab-trap logic.
- Migrate the word-count read/edit-mode parity and mermaid role/aria-label fail-then-succeed
  recovery checks out of `debugRunEditorTest()`. The word-count check now reads the real
  `#sb-pct` tooltip in both modes instead of calling `countWordsInSource`/`md.render` directly
  (`tests/specs/word-count-parity.spec.mjs`; a new `refreshEditorViews` `__MDV_TEST` hook). The
  mermaid check still drives `showDiagramError`/`renderMermaids` directly (both newly exposed) --
  there's no realistic end-to-end path that makes a syntactically valid diagram fail on its real
  first attempt (`tests/specs/mermaid-error-recovery.spec.mjs`). Verified discriminating power on
  both.
- Migrate the highlight/front-matter sections of `debugRunEditorTest()` out: the pure-logic
  checks (hljs fallback and fence-escaping, `mdvSplitFrontMatter`) move to
  `tests/node/render-node.test.mjs` (no DOM needed, no browser launch), and `buildFrontMatter()`'s
  metadata-table rendering gets its own Playwright spec, `tests/specs/frontmatter-metadata.spec.mjs`,
  exercised end-to-end through a real document rather than calling the internal helper directly.
  Verified discriminating power on the list-join logic.
- Migrate three more sections of `debugRunEditorTest()` out to the Playwright harness (search
  case-sensitivity, sidebar-resizer keyboard/pointer operability, recent-files removal focus
  management), deleting the in-page assertions in the same commit. `tests/specs/find-case.spec.mjs`,
  `sidebar-resize.spec.mjs`, `recent-files-focus.spec.mjs`; a new `setRecent` `__MDV_TEST` hook
  alongside the existing `setPositions`/`setDirty`/`setEditing`. Verified discriminating power on
  the recent-files focus-restoration logic.
- Adopt ESLint 9 (flat config, bug-finding rules only — no Prettier on `app.js`, its comment
  alignment must survive). `npm run lint`. Fixed everything it found: a useless regex escape, dead
  code, a forgotten test-state restoration, unused imports, a literal BOM byte in a regex swapped
  for the explicit escape sequence. Also surfaced two real races via `require-atomic-updates`:
  `renderMermaids()`'s shared `mermaidBusy` boolean let a stale document's cleanup clobber a newer
  document's still-active render (fixed with a per-generation lock, `mermaidBusyGen`;
  `tests/specs/mermaid-supersede.spec.mjs`), and `tools/golden/render-node.mjs`'s `loadRenderer()`
  let concurrent callers each build a redundant renderer before the cache populated (fixed by
  memoizing the promise, not the value). Verified discriminating power on both.
- Add `npm run dev`: serves `assets/` straight from disk (zero drift from the real app, reusing
  the exact same dev-origin/fake-native mirrors and bridge shim the Playwright suite depends on),
  opens a real Chromium window, and reloads it automatically on any file change. `--attach` adds
  a CDP endpoint for an external debugger. `tests/node/dev-serve.test.mjs`.
- Fix the `__abs__/` traversal-check probe hardcoding its target directory name as a second,
  independent copy of `tools/regression.ps1`'s own `$travTargetDir` — a rename in just one place
  would have left the check silently passing for the wrong reason. New `--mdv-trav-dir=`
  (main.cpp) forwards that one variable to the page instead.
- Add Export as HTML (a standalone, hand-styled copy — not the live app's own theme) and Copy as
  rich text (real HTML + plain text on the clipboard) to the `⋮` menu. PDF export remains open —
  it needs WebView2's native `PrintToPdf` API, tracked as its own future increment; `Ctrl+P`
  already reaches "Microsoft Print to PDF" via the OS print dialog. `tests/specs/export.spec.mjs`;
  verified discriminating power on the interactive-chrome-stripping logic.
- Add outline collapse: a section-list heading with children gets a disclosure toggle,
  collapsing hides that whole nested run in place. Composed with the existing outline filter —
  filtering ignores collapse while a query is active, so searching finds a match nested under a
  folded heading instead of hiding it. `tests/specs/toc-collapse.spec.mjs`; verified
  discriminating power on the collapse-range boundary and the filter-overrides-collapse rule.
- Add lightbox zoom and pan: wheel, zoom-in/zoom-out/reset buttons, `+`/`-`/`0` keys, and a plain
  click on the image (1x↔2x, told apart from drag-to-pan by pointer movement). Pan is clamped so
  the image can never be dragged off-screen; a click on the image no longer closes the lightbox
  (it's the zoom surface now — only the backdrop does). `tests/specs/lightbox-zoom.spec.mjs`;
  verified discriminating power on the pan-clamp and the click/drag distinction.
- Add document info to the F1 panel: encoding, BOM, line endings, on-disk size, and last-modified
  time. Native already tracked BOM/CRLF for save-time preservation and file size/mtime for the
  watcher, but never sent any of it to the page. `NormalizeToUtf8` gained an optional out-param
  reporting which encoding it actually detected. Found and fixed a real bug along the way:
  leaving edit mode was silently wiping a document's real info back to defaults on every preview
  render. `tests/specs/document-info.spec.mjs`, 6 new `test-textio.cpp` cases, and new native
  regression coverage of the real (not just JS-mirrored) message content; verified discriminating
  power on both the encoding-tag mechanism and the preview-preservation fix.
- Add whole-word and regex Find modes, and fix phrase matching across inline markup (searching
  "bold text" now matches `**bold** text` — the old per-text-node scan couldn't see across a
  `<strong>` boundary). One shared regex-based matcher now backs both reading and edit mode;
  reading-mode matches are scoped to one block-level container at a time, so a phrase can span
  inline markup without ever falsely matching across a paragraph/list-item boundary. New
  `find-word`/`find-regex` toggle buttons next to the existing match-case one.
  `tests/specs/find-options.spec.mjs`; verified discriminating power on all three mechanisms.
- Regression suite now cleans up its own scratch artifacts (four full exe copies plus every
  scratch doc/log/image, ~20MB+ accumulating forever across runs) at the end of a clean pass —
  a failing run still leaves them in place for post-mortem inspection.
- Update README to match the current project: the assets manifest, `tools/`, all 12
  test-injection `--mdv-*` flags, the real 35-scenario regression count, accurate binary size,
  vendored Turndown, and a new "Fast tier" section for the Node/Playwright tooling built up over
  this session. Added `THIRD-PARTY-NOTICES.md` listing every bundled vendor library's license.
  This project's own LICENSE is left for the user to choose — not invented on their behalf.
- Add `tools/check-accel-parity.mjs` (`npm run check:accel`), guarding the keyboard-accelerator
  list duplicated between `main.cpp`'s `HandleAccelerator()` and `app.js`'s keydown handler —
  previously any edit to one without the other would silently drift until a real user hit a key
  that either double-fired or stopped working. Parses both real source files and diffs the
  Ctrl-combo and function-key sets; verified discriminating power in both directions.
- Fix `S.positions` (remembered scroll positions, capped at 40) evicting by first-insertion
  order instead of least-recently-used — a document just re-opened and scrolled in could still
  be the one dropped, while something untouched for weeks survived, because plain-object key
  reassignment doesn't move a key's `Object.keys()` position. `rememberPosition()` now deletes
  and reinserts the touched key so eviction genuinely targets the oldest-untouched entry.
  `tests/specs/positions-lru.spec.mjs`; verified discriminating power (temporarily reverted the
  fix, confirmed the just-touched key was wrongly evicted instead of the real one, exactly as
  predicted). Also fixed a stale comment (`app.js`'s roving-tabindex setup said "21 buttons" —
  there are 25). Full 52 Playwright specs + 38 Node tests green.
- Add an outline filter: a text box above the section list narrows it to headings matching
  what's typed (substring, case-insensitive) instead of scrolling through a long list by hand.
  Hides non-matching `<li>` entries in place rather than rebuilding the list, so the scroll-
  driven active-link tracking (`setActiveTocLink()`) keeps operating on the exact same elements
  regardless of what's currently filtered out. Resets automatically whenever the outline itself
  is rebuilt (new document, switching between read/edit) — a stale query carried over from a
  different document could otherwise hide every entry of one sharing no section titles with it.
  A generic existing guard (any real `<input>`/`<textarea>`/`<select>` suppresses single-letter
  shortcuts) already covers this new input with no changes needed. `tests/specs/toc-filter.spec.mjs`;
  verified discriminating power. Full 35-scenario native suite + 51 Playwright specs green.

- Add lightbox next/previous: new prev/next buttons and Left/Right arrow keys step through a
  document's images without closing and reopening the lightbox for each one. Found and fixed a
  real, if obscure, browser-quirk bug along the way: disabling the currently-focused nav button
  at a boundary (reaching the last image via click, most commonly) blurs it straight out of the
  modal to `<body>` — a disabled element can't hold focus — silently breaking every subsequent
  keyboard interaction, since the modal's own `keydown` listener never sees events that no
  longer bubble through it. Fixed by redirecting focus back to the close button whenever it
  happens (checked via containment, not the disabled property directly, which has already
  changed by the time it's checked). Also fixed the existing Tab-focus-trap to filter out
  disabled controls when computing its first/last boundary — the same disabled-boundary-button
  case could otherwise become an unreachable "last" the trap could never actually wrap from.
  `tests/specs/lightbox-nav.spec.mjs`; verified discriminating power on both fixes. Full
  35-scenario native suite + 49 Playwright specs green.

- Add a true zen mode on `F11`: fullscreen already hid the OS window chrome, but this app's own
  topbar and status bar stayed fully visible. Now `F11` (via the same existing `fs` message
  native already sends) hides both too, layered on top of whatever their own independently-
  managed `.hidden` state already is via a `data-zen` attribute — nothing to restore on exit,
  removing the attribute just stops overriding it. All keyboard shortcuts stay fully functional
  (only visual button access changes), and `Esc`/`F11` remain the documented way out, already
  toasted on entry. `tests/specs/zen-mode.spec.mjs` (simulates native's `fs` message the way the
  harness has to, since there's no real window to drive); verified discriminating power. `README`/
  help panel updated. Full 35-scenario native suite + 48 Playwright specs green.

- Add a spellcheck toggle: the editor's spellcheck was hardcoded off (`index.html`'s
  `spellcheck="false"`) with no way to turn it on. New Aa-panel checkbox (`S.spellcheck`,
  default off — same as before) drives the editor's real `spellcheck` DOM property directly in
  `applyPrefs()`, since it's not something `boot.js`'s CSS-variable approach can set (it runs in
  `<head>`, before `#editor` even exists). Also covered by the existing `bindPref` self-test's
  checkbox table. `tests/specs/spellcheck-toggle.spec.mjs`; verified discriminating power. Full
  35-scenario native suite + 47 Playwright specs green.

- Fix the Aa reading-settings panel's font and letter spacing never reaching the editor —
  `#editor`'s CSS consumed `--content-size`/`--content-lh` (size, line-height) already, but hard-
  coded `--code-font` for its font-family and had no `letter-spacing` rule at all, so a chosen
  reading font (including the dyslexia-friendly one) and any letter-spacing adjustment applied
  only to the rendered view, not to editing. Now uses `--content-font`/`--content-ls`, same as
  `#content` — matching how several well-known markdown editors (Typora, iA Writer, Obsidian's
  source mode) already apply the reading font to editing too, and worth it in particular for
  letter-spacing, a real accessibility accommodation a reader who needs it wants everywhere they
  read their own text, not just half the app. `tests/specs/editor-typography.spec.mjs`; verified
  discriminating power. Full 35-scenario native suite + 46 Playwright specs green.

- Fix `Ctrl+E` always landing the caret at line 1 regardless of reading position: `enterEdit()`
  now captures `currentHeadingIndex()` (which section was on screen) before switching modes, and
  maps it through `sourceHeadings()` to the matching heading's real offset in the source, so the
  editor opens already scrolled to where the reader actually was. Falls back to the start when
  nothing was "current" yet (scrolled to the top, or no headings at all) — the previous, only
  behavior. `tests/specs/edit-position-sync.spec.mjs`; verified discriminating power. Full
  35-scenario native suite + 45 Playwright specs green.

- Fix word counts (status-bar tooltip and the F1 document-info panel) including text the reader
  never actually sees: a code block's `.codebar` (language label + "Copy"/"Copied ✓" button),
  every heading's `.hanchor` anchor icon ("#"), mermaid's injected `<style>`, and KaTeX's
  visually-hidden MathML/TeX-source duplicate of each formula. Both counts previously used a bare
  `.textContent` scan; now share a new `countVisibleWords()` (and the `isVisibleContentTextNode()`
  predicate `collectMatches()` — search — already had, extracted so all three surfaces can never
  drift apart on what counts as "visible content"). `tests/specs/word-count.spec.mjs`; verified
  discriminating power (disabling the exclusion reproduced the exact inflated count, off by
  exactly the 3 excluded tokens). Full 35-scenario native suite + 43 Playwright specs green.

- Fix front matter mis-parsed as a setext heading in the editor-mode outline: `sourceHeadings()`
  had no front-matter awareness at all, so a `key: value` line immediately before front matter's
  closing `---` delimiter read exactly like setext heading text with its underline right after,
  becoming a bogus section — the editor outline literally had a different shape than the same
  document's read-mode outline (which already excludes front matter, rendered separately via
  `buildFrontMatter()`). Now reuses the shared `splitFrontMatter()` to skip the front-matter block
  before scanning, same as the render path already does; heading `index` values stay relative to
  the original full text (the skipped prefix length is added back in), since `gotoSourceIndex()`
  uses them to place the caret in the real editor content. `tests/specs/source-headings-
  frontmatter.spec.mjs`; verified discriminating power (disabling the skip reproduced the exact
  bogus-heading bug). Full 35-scenario native suite + 42 Playwright specs green.

- Add copy-link-to-heading: every heading's `#` anchor now carries a real `file:///…#id` URI as
  its `href` (a genuine document path + heading id) instead of a bare `#id` that only ever meant
  anything inside this app's own synthetic origin. WebView2's context menu already keeps "Copy
  link location" (`main.cpp`, trimmed at startup) — right-clicking the anchor now copies
  something actually portable, with zero new UI, zero new native code, and zero new
  clipboard-writing JS: it's entirely built from existing app + browser infrastructure. Left-click
  still just scrolls to the heading in place (a new `data-heading` attribute is what the click
  handler acts on, not the href's shape) — a document with no real path (new/untitled) falls back
  to the old plain `#id` href, since there's no file to reference. `tests/specs/heading-anchor-
  link.spec.mjs`; verified discriminating power (disabled the click interception — the heading
  never gained focus, the tell that `gotoHash()` hadn't actually run, since Playwright's own
  pre-click auto-scroll can satisfy a bare "did it scroll" assertion on its own). Full
  35-scenario native suite + 40 Playwright specs green.

- Add live task checkboxes: clicking one while reading toggles it and writes the change back into
  `doc.source` immediately, marking the document dirty — no need to enter edit mode first for
  the single most common one-off edit. `md-setup.js`'s `markdown-it-task-lists` config switched
  from `enabled: false` to `true`, and `decorate()`'s existing defense against stray/hand-authored
  `<input>` elements in raw HTML now exempts only the real, plugin-generated checkboxes (matched
  by class, not by trusting arbitrary markup) — every other checkbox/radio in a document still
  gets force-disabled exactly as before. A rendered checkbox is mapped back to its source line via
  the real `md.parse()` token stream (the `list_item_open` token's own `class="task-list-item"` +
  `.map`), not a hand-rolled regex — reliable across nested/blockquoted task items without
  reimplementing CommonMark's block rules. `editor.value` is kept in sync with `doc.source` on
  every toggle, since `enterEdit()` reuses `editor.value` as-is once the document is already
  dirty; missing this would have silently reverted a checkbox toggle the next time edit mode was
  entered — caught and fixed via `tests/specs/task-checkbox.spec.mjs`, which also confirms a
  hand-authored raw-HTML checkbox stays inert. Verified discriminating power on both properties
  (the editor-sync fix and the decorate() exemption) by disabling each in turn. Updated `demo.md`
  (which claimed task lists were "read-only, like on GitHub" — no longer true), `README.md`, and
  the help panel to describe the new behavior. Full 35-scenario native suite + 37 Playwright specs
  green.

- Investigated "lazy renderer" (the last "measured performance" item): built and fully tested a
  split of the 709KB vendor `<script>` block into an eager ~240KB core (markdown-it + plugins +
  DOMPurify) plus on-demand KaTeX/mhchem/texmath + highlight.js/language-packs (66% of the
  total), gated on a cheap regex hint per document — same `ensureMermaid()`/`ensureTurndown()`
  idiom already used elsewhere. Honest result: it doesn't help. New Resource-Timing
  instrumentation (kept, `[js:vendorScriptsMs]`) measured a consistent ~2.1s of parser-blocking
  script execution on every launch, cold or warm profile — but reducing the eager payload by
  66% didn't move that number at all (still ~2.1s). `index.html`'s own HTML resource loads in
  ~5-12ms and `app.js`'s first line runs within ~10ms of the last vendor script, so the cost is
  genuinely concentrated in that execution window, but isn't proportional to how much code is
  in it — most likely a fixed per-process V8/renderer warmup cost, not something page-level
  script splitting can fix. Reverted the split (real added complexity — new failure surface,
  ongoing maintenance — for a measured-zero benefit); kept the instrumentation as evidence for
  whoever investigates the underlying fixed cost next. Full 35-scenario suite green throughout.

- Scroll handler: cache the TOC `<a>` elements (rebuilt whenever `buildToc()`/`buildEditorToc()`
  repopulate `tocList`) and toggle `.active` on only the (at most two) links whose state
  actually changed, instead of `updateProgress()`/`highlightEditorHeading()` re-querying the
  live DOM with `querySelectorAll('a')` (a fresh NodeList allocation every single animation
  frame during a scroll) and `classList.toggle`-ing every link regardless of whether it
  changed. New `tests/specs/toc-active.spec.mjs` — no prior coverage touched this at all —
  scrolls a real multi-heading document both directions and confirms exactly one link is ever
  active and the previously-active one is genuinely cleared, not left stuck; verified
  discriminating power by disabling the `remove('active')` call (two links ended up active
  simultaneously, exactly as predicted). Full 35-scenario native suite and 35 Playwright specs
  green.

- `AppendLog`: split routine logging from fatal-path logging, and cap the log file's size.
  Every launch previously paid a full `CreateFileW`+`WriteFile`+`FlushFileBuffers`+`CloseHandle`
  cycle for each of at least 5 unconditional routine lines (instance/solo, profile sweep,
  environment created, navigating, controller created) in every build, debug or release, and
  `MDView-crash.log` grew forever with no cap. Routine logging now reuses one open handle for
  the process's lifetime and skips the per-line flush (`CloseLog()`, called once at clean
  shutdown, flushes explicitly); a new `AppendLogFatal` — used only by `CrashHandler`,
  `TerminateHandler`, and `ShowFatalError` — keeps the old fully self-contained
  open+write+flush+close behavior, since the process may not survive the next instruction on
  those paths. `RotateLogIfNeeded` caps the file at 2MB, checked once per process (when the
  routine handle first opens): past the cap, the existing file becomes `<path>.old` (at most
  one prior generation kept) and a fresh one starts. Byte-identical line format either side of
  a rotation. New regression scenario 34 seeds a real >2MB log before launch and confirms
  rotation, byte-for-byte `.old` preservation, and a fresh correctly-formatted new file;
  verified discriminating power by disabling the size check (log kept growing, no `.old`
  appeared, exactly as predicted). Full 35-scenario suite green — same log format confirmed
  across every existing regex-matching check in the suite.

- Two free wins from the plan's correctness list: `NormalizeToUtf8`'s BOM-strip now
  `erase(0,3)`s in place instead of `substr(3)` (avoids a second full-document
  allocation+copy on an already-owned, moved-from string); `SaveDocumentTo` now applies the
  line-ending conversion once and passes the already-converted text to `WriteTextFile`
  (`crlf=false`, so only the cheap BOM prefix remains for it to apply) instead of letting it
  redo the same full-document CRLF pass independently. No behavior change; `build.ps1 -Test`
  and the full 34-scenario suite both green.

- Log `ServeBytes`/`ServeStatus`'s previously-swallowed HRESULTs (`SHCreateMemStream`,
  `CreateWebResourceResponse`, `put_Response`) — a failure on any of these meant WebView2
  silently fell through to the real network for a synthetic `app.local`/`doc.local` resource,
  producing a blank or half-built page with no diagnostic trail. No toast (a page that can't
  load its own assets can't reliably show one); `AppendLog` always writes regardless of build
  type. No behavior change on the (extensively exercised) success path — full 34-scenario
  suite green. These COM-level failures aren't realistically forceable without fault-injecting
  the WebView2 SDK itself, so this skipped the usual break-it-and-verify treatment; scoped to
  identical-return, log-only additions on paths the type system already accounted for.

- Fix a document-identity race on `https://doc.local/__self__`: `fetchAndRenderFile()`
  (app.js) fetches the document body separately from the `doc` message that triggers it, so
  an in-flight request from an OLDER message, resolving after a NEWER one had already
  replaced `g_docUtf8`, could return the newer document's bytes paired with the older
  message's path/dir/name. Added a monotonic `g_docToken` (main.cpp), bumped on every
  `g_docUtf8` mutation and echoed in the `doc` message; `__self__` now 409s any request whose
  `?tok=` doesn't match the current token instead of serving stale-paired content. Ported the
  same guard into `tools/dev/origin.mjs`/`fake-native.mjs` (the Playwright/Node harness) for
  parity. New `--mdv-self-token-test` issues two real fetches through the real handler
  (stale token → 409, current → 200 with exact text) and regression scenario 33; verified
  discriminating power by disabling the check (stale token then wrongly returned 200). Full
  34-scenario suite, 38 Node tests, and 34 Playwright specs all green.

- Fix `TryAutoReload()` silently dropping a file-watcher-triggered reload when
  a real `IFileDialog::Show()` (Open/Save dialog) is genuinely blocking the
  message pump — it now re-arms the same debounce timer instead, so the
  change is applied once the dialog closes rather than lost. New
  `g_modalDepth`/`ModalScope` RAII guard around both `Show()` call sites;
  `MessageBoxW` confirmations needed no change (already protected by
  `g_dirty`, which `TryAutoReload()` already checks). New `--mdv-modal-test`
  deterministic injection and regression scenario 32; verified discriminating
  power by temporarily disabling the guard (the second render then lands
  before, not after, the simulated dialog close — the exact bug this fixes).
  Full 33-scenario suite green.

- Fix `WriteTextFile` failing to save documents from directories deeper than `MAX_PATH` —
  `GetTempFileNameW` has a hard 260-char limit unaffected by this app's `longPathAware`
  manifest setting, so a document that opened fine could not be saved. Replaced with a
  self-generated sibling filename via `CREATE_NEW`. 6 new unit tests exercising a real
  directory tree past `MAX_PATH`; verified discriminating power against the literal old
  code. Full regression suite green.

- Fix `NormalizeToUtf8` accepting overlong encodings, UTF-16 surrogate halves, and code
  points beyond U+10FFFF as "valid UTF-8" — a real (if narrow) mojibake bug for e.g. a
  CP1252 file that happens to validate under the old shape-only check. Moved the function
  from `main.cpp` into `textio.h` (unit-testable) and rewrote validation to check actual
  decoded code points. 21 new unit tests; verified discriminating power precisely (removing
  just the new range check failed exactly the 8 predicted tests). Full suite green.

- Delete dead work from the render worker's hot path (`assets/worker.js`): `extractHeadings()`/
  `inlineToLabel()` computed a `headings` array nothing in `app.js` ever read, and the worker's
  own `splitFrontMatter()` call was redundantly re-scanning text `app.js` had already stripped
  before ever sending it. Both confirmed dead/redundant by tracing the actual call chain, not
  assumed. `worker.js` 94 → 65 lines. Full regression suite green.

- Add regression scenario 31 (`back-to-back`): the relaunch-over-a-populated-profile path
  every real user hits on every reopen, which no scenario in this suite had exercised before
  (every prior scenario wipes the shared profile before launching). Own dedicated
  `--mdv-profile-dir`, isolated from every other scenario. 6 checks, full suite green.

- Instrument `SweepTempProfile()` (log `existed`/`attempts`/`ms`) and add a `process-start`
  phase-mark anchor; ran the three-arm startup experiment this was built for. Honest result:
  the sweep's own cost is genuinely small (~30–40ms for a real populated profile) and does
  NOT explain the multi-second controller-creation swings — those appear driven by general
  system load, not profile persistence, across two 4-launch experiments where fast/slow
  launches were interspersed unpredictably regardless of whether the profile was swept or
  genuinely reused. The originally-proposed atomic-rename fix is not justified by this data;
  not pursuing it. No behavior change; full regression suite green.

- Build hygiene pass (`build.ps1`): real PDBs now produced (`/Zi` + `/DEBUG`), `CrashHandler()`
  logs a resolvable module-base+RVA instead of a raw ASLR'd pointer, dropped useless `/LTCG`,
  added `/permissive- /W4 /guard:cf /Qspectre /sdl` (verified zero warnings on both
  configurations before enabling), a real `-Analyze` mode, a timestamp-guarded `.res` rebuild
  (verified both directions), and `build.ps1 -Test` finally runs `tools/test-textio.cpp`'s
  save-path unit tests. No behavior change; full 31-scenario suite re-confirmed green.

- Add `--mdv-profile-dir=` to let a launch use its own WebView2 profile directory instead
  of the shared default — the prerequisite for running `tools/regression.ps1` scenarios in
  parallel (every scenario currently wipes one shared directory before launching). New
  regression scenario 30 confirms real isolation (the custom dir is genuinely populated,
  the default dir's mtime is provably untouched). Verified discriminating power.

- Add `tools/bench/render-bench.mjs`: pure-Node renderer benchmark (min/median/MAD per
  corpus doc, ~1.6–4s for the whole corpus). `npm run bench`. Already found real signal:
  `math.md` (KaTeX-heavy) costs ~10x `tables.md` despite being a smaller document.

- Add `tools/corpus/gen-corpus.mjs`: deterministic (seeded) benchmark/golden corpus
  generator, 8 documents + a manifest with per-doc hashes and a corpus-version hash.
  Fixes `tools/profile-run.ps1`'s dead hardcoded `-CorpusDir` default (a since-deleted
  session-specific scratchpad path) — now defaults to `out\corpus` and auto-generates if
  missing. Determinism verified with real discriminating power.

- Add `tools/golden/render-node.mjs`: loads the real markdown pipeline (`md-setup.js` +
  every vendored library) into a pure-Node `vm` context — no browser, no exe, ~15ms per
  render. Foundation for the golden-snapshot layer. 6 unit tests; found a real cross-`vm`-
  realm gotcha along the way (a vm-context `Array` fails `deepStrictEqual` against a
  main-realm array literal even with identical contents).

- Add `tools/check-parity.mjs`, the migration-coverage guard: verifies `tests/MIGRATION.md`'s
  claimed migrated-test counts against Playwright's own resolved test list, not a source-level
  grep (which breaks on data-driven loops). Verified discriminating power against an inflated
  claimed count. `npm run check:parity`.

- Migrate the first slice of in-page assertions to the Playwright harness: the 31-case
  toolbar-action table (every `TOOLBAR_ACTIONS` entry plus 3 regression cases) →
  `tests/specs/toolbar.spec.mjs`, deleted from `debugRunEditorTest()` in `assets/app.js`.
  Full 30-scenario native regression suite re-confirmed green after the deletion.
  `tests/MIGRATION.md` tracks progress on the rest.

- **Milestone: the fast Playwright harness works end to end.** First 3 specs green
  (`npm run test:js`, ~470ms each, ~3s total) driving the real app.js/index.html/vendor
  assets through `tools/dev/origin.mjs` + `fake-native.mjs`. Two real bugs found and fixed:
  `doc.local` requests 404'd because Node's `req.url` never carries the host and nothing
  reconstructed it from the `Host` header; and a `debugLog` event-ordering race where
  `domSummary` could arrive and fire before a test got around to waiting for it, fixed by
  buffering every occurrence per level instead of a fire-and-forget listener.

- Add a `BOOT.testHooks`-gated `window.__MDV_TEST` hook at the end of `assets/app.js`,
  exposing the IIFE's internals (renderer, toolbar actions, editor state) to the future
  Playwright harness with no restructuring of the app itself. Verified a true no-op for
  the shipping path: full regression suite green (30 scenarios) before and after.
- Fix a real bug in `tools/dev/fake-native.mjs` found while building the Playwright fixture
  on top of it: `handle()`'s local accumulator double-recorded any message that had already
  gone through a `_post()`-based helper (`_sendToast`/`_sendDocMsg`/`_openInternal`), so
  e.g. a single failed `openPath` recorded its toast twice in `sent[]`. Made `_post()` the
  sole recording point and added an `onOutbound` hook for the fixture to deliver messages
  into the real page. Two new regression tests.

- Add `tools/dev/fake-native.mjs`, a port of `HandleWebMessage()`'s 18 inbound message
  types for the future Playwright harness/dev server. Real OS side effects are recorded,
  never performed. 12 unit tests; a first discriminating-power check found its own
  assertion had no real signal, fixed by adding an observable call counter.

- Add `tools/dev/origin.mjs`, a faithful port of `HandleWebResource()` and its
  `IsSafeLocalPath`/`IsLocalDrivePath` confinement guards, for the Playwright test
  harness and dev server (both origins, the `__abs__` media whitelist, traversal and
  UNC rejection). 12 unit tests in `tests/node/` (`npm run test:node`); discriminating
  power verified against a deliberately weakened confinement check.

- Validate the fast-harness design's biggest unknown: `tools/dev/spike-worker-import.mjs`
  confirms the real `assets/worker.js` runs `importScripts()` of all 22 vendored files over a
  local Node HTTPS origin under Playwright/Chromium, with `--host-resolver-rules` mapping
  `app.local`. Everything in Phase 2 of the tooling plan proceeds from this.

- Fix a real use-after-free in `Watcher::Stop()`: the watch thread could free its
  session and return without going through `Stop()` when the watched directory
  disappeared, leaving `Stop()`'s next call to signal a freed/closed handle.
  Reproduced deterministically (`--mdv-watch-fail=first|next`) and confirmed as a
  genuine access violation under page heap before the fix; confirmed clean after.
- Release `g_webview`/`g_controller`/`g_env` before `CoUninitialize()`, so their
  COM `Release()` calls no longer run after the apartment is torn down.

- Restore `DOMPurify.sanitize()` in the clipboard-paste path, reverting a temporary
  test-verification edit that had been left in place (`assets/app.js`).
- Remove 92 stale `pasted-image-*.png` artifacts left in `out/` by past regression runs.
- Add version control, `.gitignore`, project working notes, and this changelog.
