# Backlog

Worked top-down: bugs before features, measurement before optimization. Findings discovered
mid-task get appended here rather than chased immediately.

Status: `[ ]` open · `[~]` in progress · `[x]` done — done items move to `CHANGELOG.md` (one
line) with full detail in the commit message, not kept here. This file holds only what's left.

---

## Tooling foundation

- [x] Shrink `debugRunEditorTest()` → `debugRunNativeTest()`. Complete — see `tests/MIGRATION.md`
  (now just a short pointer) and `git log` for the ~15-commit migration series. Only the
  genuinely native-only assertions remain: `openExternal`/`__abs__`/`openPath` UNC
  defense-in-depth, and `saveClipboardImage`'s real-file-write round trip.
- [x] `npm run dev` — serves `assets/` straight from disk via the exact same
  `tools/dev/{origin,fake-native}.mjs` mirrors and `tests/harness/boot.mjs` bridge shim the whole
  Playwright suite already depends on (zero drift), opens a real visible Chromium window pointed
  at it, and reloads it automatically on any file change under `assets/` — via `page.reload()`
  from Node directly (Playwright already holds the page handle), not the SSE/EventSource design
  the plan originally sketched, which would've needed a client-side shim kept carefully out of
  anything resembling the real shipped app. `npm run dev -- path\to\doc.md` opens a real file;
  `--attach` adds `--remote-debugging-port=9222` for an external DevTools/VS Code debugger.
  `tests/node/dev-serve.test.mjs` (3 cases) verifies the server/origin/fake-native wiring and the
  CLI document-loading logic via a `MDV_DEV_SERVER_ONLY` env var that skips the actual browser
  launch — a real, visible window can't be driven headlessly, the same category as a real
  `IFileSaveDialog`. Verified discriminating power on the CLI-arg document loading.
- [x] Golden snapshots. All three layers built: A (pure-Node token stream), B
  (`tools/golden/layer-b.mjs` — normalized HTML, KaTeX subtrees collapsed to their embedded TeX
  source, `hljs` spans kept), C (`tools/golden/layer-c.mjs` — the real exe's `debugDomSummary()`
  counters, replacing `tools/regression.ps1`'s hardcoded per-document magic numbers with a real
  stored baseline). Storage: one JSON file per corpus doc under `tools/golden/snapshots/`.
  `npm run golden:update` (regenerate + overwrite) / `npm run golden:check` (regenerate fresh,
  diff, exit 1 on mismatch) — both default to Layers A+B (no exe needed); `--with-layer-c` adds
  Layer C (needs a built `out/MDView.debug.exe`, several real seconds per doc, so kept out of the
  fast tier same as `tools/run-checks.mjs`'s own planned split). Review output is
  counter-deltas-first: a Layer C mismatch reports exactly which counter changed and its
  before/after values, not just "changed". Verified discriminating power on all three layers
  (a disabled markdown-it-anchor plugin broke A+B across every document; a disabled
  `.table-wrap` decoration step broke only Layer C, on only the table-bearing documents — proving
  Layer C catches real `decorate()` regressions Layers A/B structurally can't see).
- [x] Corpus + benchmarks. `tools/bench/run.mjs` (exe-level end-to-end bench — real process
  launch, real WebView2 controller creation, real IPC; complements the pure-Node
  `render-bench.mjs`, which can't see any of that cost) writes each run to `tools/bench/history/`
  (gitignored — machine-specific timing). `tools/bench/compare.mjs` gates a run against the
  committed `tools/bench/baseline.json` (`npm run bench:compare`), flagging a document only when
  its median moves by more than `max(5% of baseline, 3×baseline MAD)` — real runs have shown MAD
  in the thousands of ms for some documents (WebView2/vendor-script load noise), so a plain
  percentage-only gate would misfire constantly. `tools/bench/promote.mjs` (`npm run
  bench:promote`) is the deliberate step that overwrites the baseline after an accepted perf
  change. `tools/bench/trend.mjs` (`npm run bench:trend`) charts medians across all local history
  entries, for a slow drift too small to trip any single compare. Verified discriminating power:
  a synthetic +500ms shift on a low-noise document (threshold ±278ms) flagged; the same +200ms
  shift on a high-noise document (threshold ±7447ms, from its own historical MAD) correctly did
  not.
- [x] `tools/regression.ps1` → scenario registry: all 37 scenarios are now named, independently
  invokable units (`Add-Scenario 'name' { ... }`, dot-sourced -- not called -- by a CLI driver at
  the bottom, so every scenario's local variables still land in the same shared top-level scope
  they always did, preserving cross-scenario visibility like scenario 10's `$travTargetDir`
  without any scoping changes). `-List` prints every name; `-Only`/`-Skip` (comma-separated) run a
  subset; `-ResultsJson` writes one `{name, checks, failed, ms}` per scenario that ran. An
  expected-check-count guard fails any scenario that produces zero `Check()` calls (a silent
  no-op/early-return). No parameters still runs everything, in the same order, matching this
  script's old unconditional behavior exactly (verified: same 178/178 pass count as the
  pre-refactor baseline). Converted mechanically (a small one-off Node script, not hand-edited
  line by line, given the size) rather than freehand, specifically to avoid transcription
  mistakes across ~1300 lines; caught and fixed three real issues along the way: the one
  here-string's body/closing delimiter must never be reindented (would silently corrupt its
  Markdown test content and break PowerShell's own column-0 requirement for `'@`), a generic `$sw`
  variable name collided between the driver's own per-scenario Stopwatch and the log-rotate
  scenario's unrelated `StreamWriter` also named `$sw` (fixed by using distinctively-named
  `Get-Date` timestamps instead of a shared Stopwatch object), and the teardown's
  `Remove-Item $travTargetDir` crashed when `-Only`/`-Skip` left scenario 10 out of a run (fixed
  with a null guard). **`-Parallel` deliberately excluded**: every scenario still shares one
  scratch work directory, which would race under real concurrency -- needs its own work-dir
  isolation first, a separate and larger redesign, left for a future increment.
- [x] ESLint 9 flat config, bug-finding rules only, all vendor globals declared explicitly (no
  Prettier — `app.js`'s comment alignment must survive). `npm run lint`. Surfaced two real races
  along the way: `renderMermaids()`'s shared `mermaidBusy` boolean let a stale document's cleanup
  clobber a newer document's in-flight render (fixed via per-generation `mermaidBusyGen`,
  `tests/specs/mermaid-supersede.spec.mjs`), and `tools/golden/render-node.mjs`'s `loadRenderer()`
  let concurrent callers each build a redundant renderer before the cache populated (fixed by
  memoizing the promise, not the value).
- [x] PSScriptAnalyzer for PowerShell (`build.ps1`, `tools/*.ps1`). `PSScriptAnalyzerSettings.psd1`
  (bug-finding rules only, same philosophy as `eslint.config.js`) + `tools/check-powershell.ps1`.
  Fixed two real findings: `$args` (PowerShell's own automatic variable) shadowed and immediately
  overwritten in `regression.ps1`/`profile-run.ps1` (renamed to `$exeArgs`), and a genuinely
  unused `$soloB` process-object assignment in `regression.ps1`'s multi-instance scenario
  (dropped, along with the now-unneeded `-PassThru`). Verified discriminating power by
  temporarily reintroducing the `$args` shadowing and confirming the check caught it.
- [x] `tools/run-checks.mjs` — unified entry point. `npm run check` (fast tier, no MSVC/WebView2:
  lint · parity · accel-parity · node tests · golden A+B · Playwright · render bench — ~35s
  measured, a bit over the original ~25s aspiration, mostly `npx` subprocess-spawn overhead) and
  `npm run check:full` (adds the debug build, `test-textio`, golden C, the exe regression suite,
  exe bench + baseline compare, and a `tasklist` check for leftover `MDView*` processes). Every
  step runs to completion regardless of earlier failures, so one broken check never hides
  another; a final summary lists exactly which steps failed. Verified discriminating power by
  introducing a real syntax error: `lint` and `playwright` correctly failed (the served `app.js`
  broke, so no page ever gets `window.__MDV_TEST`) while every other step still ran and correctly
  reported OK.

## Features

- [x] Export: self-contained HTML (with KaTeX embedding), copy-as-rich-text, and true PDF export
  are all done. PDF export (`ExportPdf()`/`WritePdfExport()` in `src/main.cpp`) uses WebView2's
  own `ICoreWebView2_7::PrintToPdf` COM API — genuinely async, unlike the HTML/rich-text paths, so
  it goes through the existing `MakeCB<TIface, TArg1, TArg2>` generic callback helper (already
  used for controller/environment creation) rather than a one-off async pattern. No page-built
  payload needed (unlike HTML export): native's own print pipeline renders whatever's currently
  shown, the same one `Ctrl+P` already reaches via the OS print dialog, so it gets the existing
  `@media print` CSS rules (chrome hidden, `#content` forced visible) for free. `--mdv-pdf-test`
  (mirrors `--mdv-export-test`) proves the write side directly; its `tools/regression.ps1`
  scenario needs a longer `--mdv-exit-after` than the 800ms default, since the completion handler
  fires later on the same message loop. Verified discriminating power by skipping the real
  `PrintToPdf` call and confirming both the completion-log and file-existence checks failed.
- [x] Session restore — reopens `S.recent[0]` on a doc-less launch, gated behind a new "Reopen
  last document on launch" toggle in the Aa panel (defaults off). Resolved the three open
  questions: an explicit CLI file argument always wins (native's `BuildBootScript()` now exposes
  `hasDoc`, reflecting whatever `OpenDocument()` already decided synchronously before this ever
  runs); only the solo/first instance restores (`BuildBootScript()`'s new `solo` flag, mirroring
  `g_solo`); scroll position comes back for free once the right file reopens, since `S.positions`
  is already keyed by path. Implemented JS-side (`assets/app.js`, right before the `ready`
  post) rather than native parsing the settings blob's `recent`/`restoreLastDoc` fields itself —
  reuses the exact `openPath` message a recent-files click already sends, since native treats
  that JSON as opaque. The restore's `openPath` is posted *before* `ready`, not after: both cross
  the same message channel, so native's `ready` handler already has `g_haveDoc=true` by the time
  it runs, avoiding a `Welcome`-screen flash a post-`ready` restore would otherwise cause on every
  launch (confirmed both orderings against the real exe before settling on this one).
  `OpenDocument()` also gained a generic `if (g_debugHeadless) AppendLog(L"opened: ...")` line,
  reused by `tools/regression.ps1`'s new scenario to prove the real exe's restore path actually
  fires end to end (not just the JS decision, verified separately in
  `tests/specs/session-restore.spec.mjs`). Verified discriminating power by disabling the restore
  condition and confirming the Playwright suite's positive case failed as expected, then restoring.

## Docs and hygiene

- [x] LICENSE chosen (MIT, the user's explicit call) — see `LICENSE` and `README.md`'s new
  License section. `THIRD-PARTY-NOTICES.md` (vendored code) is unaffected.
- [x] Public-distribution prep: `git filter-repo` stripped the repeatedly-recommitted
  `out/MDView.exe`/`out/MDView.debug.exe` blobs from all history (94 MB → 13 MB `.git`; the ~13
  now-empty "Rebuild the release exe" commits were pruned along with them — 79 commits → 66).
  Both exes are now `.gitignore`d; `build.ps1` is how you get one, matching how `sdk/` and
  `assets/vendor/` were already handled (vendored source, not a committed build artifact).
  Commit author/committer email was reviewed and intentionally left as-is at the user's explicit
  request, not an oversight.

Deliberately **not** doing without another conversation: split live preview, tabs, autosave/crash
recovery, annotations, auto-hiding chrome — each fights a stated design promise.
