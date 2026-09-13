# Simple MD Viewer

A fast, accessible Markdown document viewer for Windows 11. One self-contained
executable (`out\MDView.exe`, ~5.05 MB — about 3.5 MB of that is the bundled
Mermaid diagram engine, loaded only when a document actually contains a
diagram), no installer, no runtime downloads, and no data written anywhere
outside the .exe itself — even your preferences live *inside* the executable
file.

## Using it

- **Open a file**: launch `MDView.exe` and press `Ctrl+O`, drop a `.md` file
  anywhere on the window, or pass a path on the command line.
- **"Open with"**: right-click any `.md` file in Explorer → *Open with* →
  *Choose another app* → browse to `MDView.exe` → check *Always*. (The app never
  registers itself anywhere; Windows remembers your choice on its own.)
- The document **reloads automatically** when another program saves it, keeping
  your scroll position.
- Links to websites open in your default browser; links to other Markdown files
  open in the viewer (`Alt+←` goes back). Relative images resolve next to the file.

### Getting around

- **Section list (left)** — built from the document's headings and shown by
  default. The section you're reading is highlighted as you scroll, and the
  status bar names it at the bottom. `Ctrl+B` hides or shows the list; a
  document with no headings gets no empty rail. Drag its right edge to resize
  (double-click the edge to reset; the width is remembered), and use
  `↑` `↓` `Home` `End` to move through it from the keyboard.
- **Recent files** — the `⋮` menu lists the last few documents you opened, so
  switching files doesn't mean returning to the welcome screen.
- **Session restore** (off by default — the Aa panel's "Reopen last document on
  launch") reopens the most recent file automatically instead of showing the
  welcome screen, as long as an explicit file wasn't passed on the command line
  and no other instance of the app is already running.
- **Export as HTML / Export as PDF / Copy as rich text** (the `⋮` menu) turn the
  rendered document into a standalone file or clipboard payload — HTML export
  embeds KaTeX's own CSS and fonts as base64 data URIs when the document has
  math, so it stays a single self-contained file with no external
  dependencies; PDF export uses WebView2's own print pipeline, the same one
  `Ctrl+P` already reaches through the OS print dialog.
- **Reading time** — hover the percentage in the status bar for the word count
  and an estimated reading time.
- **Pages** — the status bar shows `Page n / total`. Type a number in the box
  (or press `g`) and hit Enter to jump; the arrows step one page at a time, the
  same as `Page Up` / `Page Down`. A "page" is one screenful of *this* window,
  like an e-reader, so the count changes when you resize or zoom.
- **Back / forward** — the toolbar arrows (or `Alt+←` / `Alt+→`) undo *any*
  jump: a section you clicked in the list, a link you followed inside the
  document, a page number you typed, or a move to another file. Back returns
  you to the exact spot you were reading, forward replays the jump.

### Editing

`Ctrl+E` (or the pencil button) swaps the rendered page for the raw Markdown in
the same reading column. It is a plain text editor on purpose — Markdown *is*
text, and the renderer is one keystroke away.

- A **formatting toolbar** appears above the text area — hidden the rest of
  the time, in reading mode — covering every construct this app renders:
  headings (one button cycles the current line through H1–H6 and back to a
  paragraph), bold/italic/strikethrough/code, bullet/numbered/task lists,
  blockquote, links/images, tables, fenced code blocks, horizontal rules,
  subscript/superscript, inline and block math, Mermaid diagrams, footnotes
  (drops a reference where the caret is and the definition at the document's
  end), definition lists, abbreviations, highlights, inserted text and an
  emoji shortcode placeholder. Each
  button announces what it did for screen readers, and the toolbar follows
  the WAI-ARIA pattern for keyboard use — arrow keys, `Home` and `End` move
  between buttons without adding 20-odd extra stops to the page's Tab order.
- **Nothing is ever written without you asking.** `Ctrl+S` saves; `Ctrl+Shift+S`
  saves a copy and follows it. There is no autosave.
- `Ctrl+N` starts a **new document** — an untitled buffer that opens straight in
  the editor. Saving one asks where to put it, then carries on in that file.
- **Find and replace** live in the same find bar: `Ctrl+F` while editing adds a
  replacement box, `Replace` for the current match and `All` for every match
  (`Enter` and `Shift`+`Enter` in the replacement box do the same). The bar
  reverts to plain search when you go back to reading.
- The **section list stays live** while you type, parsed straight from the
  source — click an entry to jump the caret there. Fenced code is skipped, so a
  `# shell comment` inside a code block never becomes a section.
- The status bar shows a **live word count** and the caret's line and column
  while editing, and page numbers follow the editor's own scrolling.
- Inserting an item into a **numbered list renumbers** the rest of that list;
  nested lists and neighbouring lists are left alone.
- Every editing action — formatting, indenting, list continuation, replace —
  goes on the normal **undo stack**, so `Ctrl+Z` and `Ctrl+Y` behave. Replace
  All undoes as a single step.
- `F1` shows **document statistics**: words, reading time, headings, links,
  images, code blocks, tables, tasks done vs. total, footnotes and diagrams —
  measured from what you're editing right now, not the last preview.
- **Tables**: inside a pipe table, `Tab` tidies the columns and selects the next
  cell (`Shift+Tab` goes back, `Tab` at the last cell adds a row). Column
  alignment markers are preserved, and outside a table `Tab` still indents.
- **Pasting from a browser or word processor converts the HTML to Markdown** —
  headings, emphasis, links, lists, tables and code blocks all come through as
  Markdown rather than raw tags. `Ctrl+Shift+V` pastes the plain text instead,
  and pasting a URL over selected text still makes a link.
- **Dropping an image file while editing inserts a reference to it** at the
  caret instead of trying to open it as the document — a path relative to the
  current file's folder when the image lives under it, an absolute one
  otherwise. Dropping anywhere else (or any other file type) still opens it as
  usual.
- **Pasting a screenshot or a copied image works too** — since pasted image
  data has no file of its own, it's saved as a new `pasted-image-N.png` (or
  the matching extension) next to the document first, then referenced the
  same way a dropped file is. Unlike a drop (which only references a file
  that already existed), this writes something new to disk — a visible toast
  names the file, rather than only the quiet announcement a drop gets.
- Saves preserve the file's original **line endings and encoding** (CRLF/LF, and
  a UTF-8 BOM if it had one) and go through a temporary file first, so a failed
  write can't truncate your document.
- If another program changes the file while you have **unsaved edits**, the
  viewer keeps yours and says so instead of silently reloading over them.
  Closing with unsaved changes asks first.
- Toggling back to reading **previews your unsaved edits** without touching the
  file — headings, table of contents and all.
- While editing: `Ctrl+B` / `Ctrl+I` / `Ctrl+K` / `` Ctrl+` `` wrap the selection
  in bold, italic, a link or code; `Tab` / `Shift+Tab` indent and outdent the
  selected lines; `Enter` carries list, task-list and quote markers to the next
  line (and ends the block on an empty item); pasting a URL over selected text
  turns it into a link; `Esc` steps out of the text area. The status bar shows
  the caret's line and column.

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl+O` | Open a file |
| `Ctrl+F` or `/` | Find in document (live highlight + match count, `Aa` case toggle) |
| `F3` / `Shift+F3` | Next / previous match |
| `Ctrl+B` | Show / hide the section list |
| `n` / `p` | Jump to next / previous section |
| `g` | Go to page (type a number, press Enter) |
| `Page Up` / `Page Down` | Previous / next page |
| `Alt+←` / `Alt+→` | Back / forward — undoes section, link, page and file jumps |
| `Ctrl+N` | New document |
| `Ctrl+E` | Edit the file / back to reading |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / save a copy |
| `Ctrl` `+` / `−` / `0` | Zoom in / out / reset |
| `Ctrl+,` | Reading & accessibility settings |
| `F5` | Reload file |
| `F11` | Full screen (also hides the topbar/status bar for distraction-free reading) |
| `Ctrl+P` | Print |
| `Ctrl+W` | Close |
| `F1` | Help & shortcut list |

## What it renders

CommonMark plus the GitHub-flavored extensions and the extras modern documents
use — see the built-in **feature tour** (welcome screen → "See what it can render"):

- Headings (ATX + setext, with anchors + auto TOC + inline `[TOC]` markers),
  emphasis, strikethrough, `==mark==`, `++insert++`, sub/superscript,
  abbreviations, emoji shortcodes, smart typography
- Tables with column alignment, task lists (click a box to check it off —
  updates the file when you save), definition lists, footnotes
  (numbered/named/inline, with hover previews), nested lists/quotes, all five
  GitHub alerts (`> [!NOTE]` …)
- Fenced code with syntax highlighting (~40 languages incl. PowerShell, batch,
  Dockerfile, CMake, x86 assembly, nginx) + copy button, indented code,
  `diff` highlighting
- Math via KaTeX — inline `$…$`, display `$$…$$`, and ` ```math ` fences — with
  MathML output for screen readers, plus chemical equations (mhchem, `\ce{…}`)
- **Mermaid diagrams** (flowchart, sequence, class, state, gantt, pie, …) that
  re-theme automatically for dark mode; the engine is bundled but loaded lazily,
  so diagram-free documents pay nothing
- Images (local-relative, data URIs, remote) with lazy loading, `srcset`, and
  click-to-zoom; `<video>`/`<audio>`/`<track>` tags
- Safe embedded HTML (`<details>`, `<kbd>`, `<ruby>`, merged-cell tables, RTL
  text, …) — scripts and active content are always stripped (DOMPurify)
- YAML front matter shown as a collapsible metadata table
- Non-Markdown text files render as plain text; binary files are refused

Two deliberate divergences, both documented in `sample.md`: a *single* tilde is
a subscript (`H~2~O`), so strikethrough needs *double* tildes (`~~x~~`); and
bracket-delimited math (`\(…\)`, `\[…\]`) is not enabled, because those
delimiters collide with CommonMark's `\[`/`\(` backslash-escapes (GitHub omits
them for the same reason) — use `$`, `$$`, or ` ```math ` instead.

## Accessibility (WCAG 2.1 AA–oriented)

- Real semantic HTML → full UI Automation exposure for Narrator/NVDA/JAWS
  (verified: headings, table header/row semantics, labeled controls, live
  search-result announcements)
- Complete keyboard operability, visible focus rings, skip-to-content link,
  focus-trapped dialogs
- **Aa panel**: reading font (incl. dyslexia-friendly), text size, line & letter
  spacing, content width, high-contrast palettes, always-underline links,
  reduced motion (also honors the OS setting), image dimming in dark mode
- Light / dark / follow-system themes; respects Windows High Contrast
  (`forced-colors`) mode, and starts in high-contrast colors on first run if
  the OS asks for increased contrast
- AA+ contrast in both themes; AAA in high-contrast mode

## Where data lives

- **Preferences travel inside `MDView.exe`** as NTFS alternate data streams
  (`MDView.exe:mdv.settings`, `MDView.exe:mdv.window`). Nothing is written to
  the registry, AppData, or beside the exe. Inspect them:
  `Get-Item .\MDView.exe -Stream *`
- On a non-NTFS drive (FAT32 USB stick) preferences simply hold for the session.
- The WebView2 engine requires a browser profile directory; it's pointed at
  `%TEMP%\MDView.wv2`, runs in in-private mode, is marked for deletion on exit,
  and is swept on the next launch. Rebuilding/replacing the exe resets preferences
  (they're attached to the file).

## Building

Requires Visual Studio (any edition) with the C++ workload:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
```

Produces `out\MDView.exe` — statically linked (`/MT`), all assets (HTML/CSS/JS,
markdown-it + plugins, highlight.js, KaTeX + fonts, icon) embedded as resources
and served from memory. `tools\make-icon.ps1` regenerates the icon;
`sample.md` + `test-image.png` are a quick manual test.

The save path (message parsing, UTF-8 conversion, line-ending/BOM handling and
the atomic file write) lives in `src\textio.h` so it can be tested directly:

```bash
cl /nologo /std:c++17 /EHsc /utf-8 /I src tools\test-textio.cpp && test-textio.exe
```

### Headless profiling

`build.ps1 -Debug` produces `out\MDView.debug.exe`: the same app plus a
measurement harness, compiled in behind `#ifdef MDV_DEBUG` so none of it
exists in the shipping build. It runs off-screen, so a measurement run never
takes over the desktop.

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File tools\profile-run.ps1 -Docs mixed,tables -Repeat 9
```

| Flag | Purpose |
| --- | --- |
| `--mdv-headless` | Off-screen window, no blocking dialogs, forward page console + errors to the log |
| `--mdv-log=PATH` | Unbuffered, flushed-per-line log; every line carries elapsed-since-launch |
| `--mdv-profile=PATH` | Machine-readable JSON: phase timeline, peak working set, render stats |
| `--mdv-repeat=N` | Re-render the same document N times, report min/median/mean/max |
| `--mdv-timeout=MS` | Watchdog. Logs the phase it stalled after, writes the profile, exits 2 |
| `--mdv-screenshot=PATH` | PNG of the rendered page, captured off-screen |
| `--mdv-exit-after=MS` | Close this long after the render settles |
| `--mdv-frame-budget=MS` | Override the insertion slice budget (A/B testing) |
| `--mdv-persist-profile` | Keep the WebView2 profile between launches (A/B testing) |
| `--mdv-reopen-after=MS` | Reopen the same document MS after handoff, to test superseding an in-flight render |
| `--mdv-editor-test` | Run the write-mode toolbar's self-test (clicks every formatting button, checks the result) and report pass/fail |

The rest of the `--mdv-*` flags exist to force a specific native code path deterministically
(never a wall-clock guess) rather than waiting for a real-world race — `tools\regression.ps1` is
their only real caller:

| Flag | Forces |
| --- | --- |
| `--mdv-crash-test=seh\|terminate` | A deliberate access violation or `std::terminate()`, to prove the crash/terminate handlers actually log before the process dies |
| `--mdv-fatal-error-test` | `ShowFatalError()`'s exit path, without a real unrecoverable error |
| `--mdv-dpi-test` | A synthesized `WM_DPICHANGED` with a controlled `RECT` |
| `--mdv-save-test` | A direct `SaveDocumentTo()` call, to check the save-suppression window around the file watcher |
| `--mdv-export-test` | A direct `WriteHtmlExport()` call, since a real "Export as HTML" file picker can't be driven headlessly |
| `--mdv-pdf-test` | A direct `WritePdfExport()` call (real `PrintToPdf()`), since a real "Export as PDF" file picker can't be driven headlessly either |
| `--mdv-trav-dir=NAME` | The `__abs__/` traversal-check probe's target directory name (forwarded to the page as `BOOT.travDir`), so `regression.ps1`'s own directory name is never a second hardcoded copy |
| `--mdv-rejection-test` | A genuinely unhandled Promise rejection, to prove it still reaches `[js:error]` |
| `--mdv-self-token-test` | Two real `__self__` fetches (stale token, current token) against the actual doc-identity-token handler |
| `--mdv-minimize-test` | A real minimize/restore cycle, checking the WebView2 controller is hidden/re-shown |
| `--mdv-minmax-test` | A real `WM_GETMINMAXINFO`, checking the DPI-scaled minimum window size |
| `--mdv-dirty-on-watch` | Setting `g_dirty` at a precise instant relative to a file-watcher event (a race, not luck) |
| `--mdv-modal-test` | A simulated `IFileDialog` open/close, checking `TryAutoReload()` defers rather than drops |
| `--mdv-watch-fail=first\|next` | One of `Watcher::ThreadProc`'s two early-return paths, proving `Stop()` doesn't use-after-free |
| `--mdv-profile-dir=PATH` | A WebView2 profile directory other than the shared default, for test isolation/parallelism |

Two things this exists to prevent, both learned the hard way. Run-to-run
spread on a busy desktop routinely exceeds the size of the change being
measured, so `--mdv-repeat` and a reported median are the default rather than
an option — a single sample is not evidence. And any run can stall, so
`--mdv-timeout` guarantees termination: a hang that wedges the machine costs
far more than a run that reports a timeout and says where it stopped.

Each render also emits a structural fingerprint (`domSummary`): counts of
headings, heading anchors, table wrappers, code blocks, copy buttons, KaTeX
nodes, diagrams, alerts, task boxes and footnotes. Invariants like
"anchors == headings" and "tableWraps == tables" turn a silent regression in
the decoration pipeline into a visible number, across the whole document
rather than the one screenful a screenshot shows.

### Regression suite

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File tools\regression.ps1
```

Runs `out\MDView.debug.exe` through 37 scenarios covering everything that's
broken in practice — sync and progressive rendering (with `domSummary`
checked against known-good counts), a missing document, the watchdog firing
on a genuine stall and staying silent on a clean one, `--mdv-reopen-after`
superseding an in-flight render without corrupting the final DOM or leaving
`aria-busy` stuck, `--mdv-repeat` benchmarking, the JS heap staying bounded
across 30 renders in one process rather than climbing per-render, a live
file-watcher check (external edit triggers exactly one auto-reload) and its
use-after-free fix (`--mdv-watch-fail`), `--mdv-editor-test`'s write-mode
toolbar self-test (every formatting button clicked through its real DOM
element and `data-fmt` attribute — not called by its JS key directly, so a
mismatched attribute in `index.html` would actually be caught), crash/
terminate-handler forensics, DPI changes, minimize/restore, window
min/max sizing, UTF-16 and binary-file detection, NTFS ADS preference
corruption, Unicode filenames, dark/light theme, WebView2 profile isolation
and persistence (including a genuine back-to-back relaunch over a populated
profile), modal-dialog reentrancy, the doc-identity token, log rotation,
Export as HTML/PDF actually writing a real file to disk, and session restore
reopening the last document on a doc-less launch. Every scenario also
asserts no uncaught JS error reached the
page's global handler — that check alone caught a real one: terminating a
worker mid-`importScripts` during supersede logged a spurious `NetworkError`
because `worker.onerror` didn't call `preventDefault()`, so it doubled as an
uncaught page error on top of the app's own (already-correct) handling.
Prints one PASS/FAIL line per check and exits non-zero if anything fails.

Each scenario is independently named and invokable: `-List` prints every
scenario name and exits, `-Only a,b,c` / `-Skip a,b,c` (comma-separated, no
spaces — real PowerShell array syntax, not a naive string split) run a
subset, and `-ResultsJson path.json` writes a `[{name, checks, failed, ms}]`
array for one entry per scenario that ran. The default (no parameters) is
unchanged: every scenario, in the order above. Not (yet) parallelizable —
every scenario still shares one scratch work directory, which would race
under concurrent execution; that needs its own work-dir-isolation redesign
first (`docs/BACKLOG.md`).

### Fast tier (no exe, no WebView2)

```bash
npm run test:node      # 38 Node unit tests -- origin/message-bridge mirrors, corpus, render-node
npm run test:js        # Playwright + Chromium against the real app.js/md-setup.js, 52 specs
npm run check:parity   # confirms tests/MIGRATION.md's claimed counts against Playwright's own --list
npm run check:accel    # confirms main.cpp's and app.js's accelerator-key lists still agree
npm run bench          # pure-Node renderer benchmark (no exe) -- tools/bench/render-bench.mjs
npm run corpus         # (re)generates the deterministic seeded test-document corpus
```

All five run in seconds, not the ~4 minute native cycle, because `assets/md-setup.js` is DOM-free
by construction and `tools/dev/{origin,fake-native}.mjs` mirror `main.cpp`'s resource server and
message handler closely enough that Playwright + Chromium can drive the real, unmodified
`assets/app.js` without the exe at all.

## Architecture

```
src/main.cpp      Win32 shell: window, WebView2 host, ADS prefs, file watcher,
                  accelerator keys, in-memory resource server (https://app.local),
                  local media server for doc-relative files (https://doc.local)
assets/           Viewer UI: index.html, boot.js, app.js (one IIFE, the whole
                  app), app.css, demo.md, plus md-setup.js (the DOM-free
                  markdown-it setup shared byte-for-byte with worker.js,
                  which does progressive rendering for documents >= 50,000
                  chars off the main thread)
assets/vendor/    Pinned rendering libraries (markdown-it 14, KaTeX 0.16 +
                  mhchem, highlight.js 11 + language packs, Mermaid 11,
                  DOMPurify 3, Turndown + its GFM plugin for HTML->Markdown
                  paste, markdown-it plugins)
sdk/              WebView2 SDK 1.0.4129.50 (header + static loader)
tools/            Dev/test tooling (Node, not shipped): regression.ps1 and
                  profile-run.ps1 drive the real exe headlessly; dev/
                  mirrors main.cpp's resource server and message handler so
                  Playwright can drive the real app.js without the exe;
                  golden/, corpus/ and bench/ back the render-correctness
                  and performance tooling described below
```

Rendering uses the Windows-provided WebView2 (Chromium) runtime — the reason a
~5 MB exe gets GitHub-quality typography, math, diagrams, and a real
accessibility tree. A strict CSP confines the page; document HTML is sanitized
(DOMPurify); navigation is locked to the app origin; external links go through
`ShellExecute` only. Document-referenced local media is confined to the
document's own folder, and network (UNC / protocol-relative) paths are refused
at two layers so a malicious file can't trigger an outbound SMB/NTLM
authentication.

### Not included (by choice)

- File-type registration, auto-update, telemetry: none, deliberately.
- Remote images load by default (a core Markdown feature); if you'd rather a
  document never reach the network on open, drop `http:`/`https:` from the
  `img-src` in `assets/index.html`.

## License

MIT — see [`LICENSE`](LICENSE).

## Third-party licenses

`assets/vendor/` and `sdk/` bundle several open-source libraries (markdown-it, KaTeX,
highlight.js, Mermaid, DOMPurify, Turndown, …) plus Microsoft's WebView2 SDK — see
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for the full list and license per library.
