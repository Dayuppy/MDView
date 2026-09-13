# Headless regression suite: runs MDView.debug.exe through the scenarios that
# have mattered in practice — not a general fuzzer, but the specific things
# that have actually broken or needed verifying during development (a
# supersede corrupting the DOM, a debug-only crash-only-under-load, a hang
# that only shows up as a stall in one particular phase). Each check is
# something that was, at some point, verified by hand; this exists so the
# next change can verify it in thirty seconds instead of by hand again.
#
#   .\tools\regression.ps1
#
# Exits 0 if every check passes, 1 otherwise. Prints one PASS/FAIL line per
# check plus a reason on failure.
param(
    [switch]$List,                # print every registered scenario name, one per line, and exit
    [string[]]$Only,               # run only these scenarios (by name, from -List), in registration order
    [string[]]$Skip,               # run every scenario except these
    [string]$ResultsJson            # write a JSON array of {name, checks, failed, ms} per scenario that ran
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root 'out\MDView.debug.exe'
$work = Join-Path $env:TEMP 'mdview-regression'
New-Item -ItemType Directory -Force $work | Out-Null

if (-not (Test-Path $exe)) {
    Write-Host "MISSING $exe — run build.ps1 -Debug first" -ForegroundColor Red
    exit 1
}

$failures = 0
function Check([bool]$cond, [string]$name, [string]$detail = '') {
    $script:scenarioChecks++
    if ($cond) {
        Write-Host "PASS  $name"
    } else {
        Write-Host "FAIL  $name  $detail" -ForegroundColor Red
        $script:failures++
    }
}

function Run([string]$doc, [string[]]$extra, [string]$tag) {
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $log = Join-Path $work "$tag.log"
    $prof = Join-Path $work "$tag.json"
    Remove-Item $log, $prof -ErrorAction SilentlyContinue
    # 60s: controller-creation has been observed taking 20s+ under system
    # load (see README's headless-profiling notes) — a tighter budget here
    # would turn ordinary machine load into a false regression failure.
    $exeArgs = @('--mdv-headless', "--mdv-log=$log", "--mdv-profile=$prof",
              '--mdv-timeout=60000', '--mdv-exit-after=800') + $extra + @($doc)
    $p = Start-Process -FilePath $exe -ArgumentList $exeArgs -PassThru -Wait -WindowStyle Hidden
    $logText = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
    [PSCustomObject]@{ ExitCode = $p.ExitCode; Log = $logText; ProfilePath = $prof }
}

# Applied after every scenario below: an uncaught JS error should never reach
# the page's global handler, regardless of which path a render took. Not
# scenario-specific on purpose — this is what actually caught the
# terminate-mid-importScripts race during supersede.
function CheckNoJsErrors([PSCustomObject]$r, [string]$tag) {
    Check (-not ($r.Log -match '\[js:error\]')) "$tag`: no uncaught JS errors" $r.Log
}

# --- generate small fixed test documents -----------------------------------
$largeDoc = Join-Path $work 'large.md'
if (-not (Test-Path $largeDoc)) {
    # A reference-style link and footnote used right at the top, defined only
    # at the very bottom -- both are resolved once during markdown-it's single
    # md.parse() pass in worker.js, before mdvChunkTokens ever splits the
    # already-resolved token stream into per-chunk render() calls, so this
    # ordering should survive chunking intact. Worth locking in as a permanent
    # check rather than trusting that by reading the code alone: an
    # unresolved reference produces no <a>/footnote markup at all, so
    # domSummary's already-generic links=/footnotes= counters below are
    # enough to prove it without any test-specific hooks in app.js.
    $lines = @('# Regression Large Doc', '',
        'See [link text][myref] and this footnote[^1] used near the top.', '')
    for ($i = 0; $i -lt 400; $i++) {
        $lines += "## Table $i", '', '| Alpha | Beta | Gamma |', '| --- | --- | --- |'
        for ($r = 0; $r -lt 8; $r++) { $lines += "| a$r value | b$r value | c$r value |" }
        $lines += ''
    }
    $lines += '[myref]: https://example.com/regression-reftest "a title"', ''
    $lines += '[^1]: This is the footnote definition text.'
    Set-Content -Path $largeDoc -Value ($lines -join "`n") -NoNewline
}
$demo = Join-Path $root 'assets\demo.md'
$missing = Join-Path $root 'assets\does-not-exist-regression.md'


# ---------------------------------------------------------------- scenarios
# Each scenario is a named, deferred scriptblock -- registered here, actually
# run later by the CLI driver at the bottom of this file (default: every
# scenario, in this order, exactly like this script's old unconditional
# top-to-bottom body). Dot-sourced when run (". $scenarios[$name]", not "&"),
# not called -- keeps every scenario's local variables landing in this same
# top-level scope exactly as they did before this was split into named
# blocks, so nothing about cross-scenario variable visibility (e.g. the
# final cleanup block below still reading scenario 10's $travTargetDir)
# changes just because a scenario now has a name.
$scenarios = [ordered]@{}
function Add-Scenario([string]$name, [scriptblock]$body) { $scenarios[$name] = $body }


Add-Scenario 'sync' {
    # --- 1. sync path renders correctly ----------------------------------------
    $r = Run $demo @() 'sync'
    Check ($r.ExitCode -eq 0) 'sync: clean exit'
    Check ($r.Log -match 'domSummary.*headings=17.*tables=2.*mermaid=1') 'sync: structural fingerprint matches demo.md' $r.Log
    Check ($r.Log -match 'ariaBusy=false') 'sync: aria-busy cleared'
    CheckNoJsErrors $r 'sync'
    # demo.md on disk is plain UTF-8 (no BOM), LF line endings, 6574 bytes -- the
    # real SendDocMsg()'s new doc-info fields (docs/BACKLOG.md's Features #10),
    # not the JS-side fake-native.mjs mirror Playwright already covers.
    Check ($r.Log -match 'doc-info: encoding="UTF-8" bom=0 crlf=0 size=6574') 'sync: SendDocMsg reports the real encoding/bom/crlf/size for demo.md' $r.Log

}

Add-Scenario 'progressive' {
    # --- 2. progressive path renders correctly ----------------------------------
    $r = Run $largeDoc @() 'progressive'
    Check ($r.ExitCode -eq 0) 'progressive: clean exit'
    Check ($r.Log -match 'path=progressive') 'progressive: took the worker path'
    Check ($r.Log -match 'tables=400') 'progressive: full table count present (no truncation)' $r.Log
    # Not a links= count check: markdown-it-anchor stamps one <a> per heading
    # (anchors=401 here) and each footnote contributes two (a ref link at the use
    # site, a backref at the definition), so the "real" total for one link plus
    # one footnote is 404, not the naive 1 -- a hand-counted assumption caught by
    # actually running this rather than trusting the arithmetic. footnotes=1
    # alone is unambiguous (that counter only counts .footnotes li, nothing
    # heading-anchor-related can inflate it) and exercises the identical
    # resolution mechanism as the reference link (both are resolved once during
    # worker.js's single md.parse() pass, before mdvChunkTokens ever splits the
    # token stream), so a regression in either would show up here.
    Check ($r.Log -match 'footnotes=1\b') 'progressive: footnote/reference defined at doc end still resolves across a chunk boundary' $r.Log
    Check ($r.Log -match 'ariaBusy=false') 'progressive: aria-busy cleared'
    CheckNoJsErrors $r 'progressive'

}

Add-Scenario 'no-doc' {
    # --- 3. missing document doesn't hang ---------------------------------------
    $r = Run $missing @() 'nodoc'
    Check ($r.ExitCode -eq 0) 'no-doc: clean exit, does not hang'
    CheckNoJsErrors $r 'no-doc'
    # showWelcome() (app.js) posts {type:'title', text:'Welcome'} when there's no
    # document to derive a title from -- a separate code path from the ordinary
    # per-document UpdateTitle() (native), used only here and for the built-in
    # feature-tour/demo doc. Never checked by anything in this suite; the window
    # title itself (not just "did the process exit cleanly") is the actual
    # user-visible signal that a missing/unopenable file correctly falls back to
    # the welcome screen rather than, say, silently doing nothing.
    Check ($r.Log -match 'title-message: text="Welcome"') 'no-doc: the welcome screen''s own title path fires, not just UpdateTitle()''s ordinary per-document one' $r.Log

}

Add-Scenario 'watchdog' {
    # --- 4. watchdog fires on a genuine stall, and only then --------------------
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $log = Join-Path $work 'watchdog.log'
    Remove-Item $log -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$log", '--mdv-timeout=300', $demo) -PassThru -Wait -WindowStyle Hidden
    $wdLog = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
    Check ($p.ExitCode -eq 2) 'watchdog: exits 2 on a real stall'
    Check ($wdLog -match 'WATCHDOG:') 'watchdog: logs the diagnostic'

    $r = Run $demo @() 'no-false-watchdog'
    Check (-not ($r.Log -match 'WATCHDOG:')) 'watchdog: never fires on a normal run' $r.Log

}

Add-Scenario 'supersede' {
    # --- 5. supersede: reopening mid-render produces correct, uncorrupted output
    $r = Run $largeDoc @('--mdv-reopen-after=40') 'supersede'
    Check ($r.ExitCode -eq 0) 'supersede: clean exit'
    Check ($r.Log -match 'tables=400') 'supersede: final DOM has the full, correct document' $r.Log
    Check (([regex]::Matches($r.Log, 'renderComplete')).Count -eq 1) 'supersede: exactly one completion (no stale/duplicate render)' $r.Log
    Check ($r.Log -match 'ariaBusy=false') 'supersede: aria-busy cleared, not left stuck true'
    CheckNoJsErrors $r 'supersede'

}

Add-Scenario 'repeat' {
    # --- 6. repeat benchmark produces sane stats --------------------------------
    $r = Run $demo @('--mdv-repeat=5') 'repeat'
    Check ($r.Log -match 'benchComplete') 'repeat: benchmark completes'
    Check ($r.Log -match 'n=5') 'repeat: ran the requested number of iterations'
    CheckNoJsErrors $r 'repeat'

}

Add-Scenario 'leakcheck' {
    # --- 7. JS heap doesn't blow up across many renders in one process ----------
    # Calibrated against real measurements: the large doc plateaus around
    # 30-32MB whether repeated 60 or 250 times in a single process (near-flat,
    # not proportional to N) — a genuine per-render leak would instead climb
    # roughly linearly. 100MB gives generous headroom above that observed
    # plateau while still catching an actual multi-hundred-percent regression.
    $r = Run $largeDoc @('--mdv-repeat=30') 'leakcheck'
    Check ($r.Log -match 'jsHeapMB=([\d.]+)') 'leakcheck: heap reading present'
    if ($r.Log -match 'benchComplete.*jsHeapMB=([\d.]+)') {
        $heapMB = [double]$matches[1]
        Check ($heapMB -lt 100) "leakcheck: JS heap stays bounded after 30 renders ($heapMB MB)" $r.Log
    }
    CheckNoJsErrors $r 'leakcheck'

}

Add-Scenario 'watcher' {
    # --- 8. external file change auto-reloads when not dirty/editing -----------
    # Exercises the file-watcher path end to end (Watcher -> WM_APP_WATCH ->
    # TIMER_RELOAD -> TryAutoReload -> ReloadDoc) for the ordinary case: nothing
    # dirty, nothing being edited. TryAutoReload also re-checks dirty/editing
    # right before reloading rather than only when the change notification
    # first arrived, specifically so a reader who starts editing during the
    # 150ms debounce doesn't get their in-progress edit blown away -- that race
    # is covered separately by scenario 20 (dirty-race) via deterministic
    # injection, not by anything here.
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $watchDoc = Join-Path $work 'watch.md'
    Copy-Item $demo $watchDoc -Force
    $watchLogPath = Join-Path $work 'watch.log'
    Remove-Item $watchLogPath -ErrorAction SilentlyContinue
    $wp = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$watchLogPath",
        '--mdv-timeout=60000', '--mdv-exit-after=4000', $watchDoc) -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(55)
    $sawFirstRender = $false
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $watchLogPath) -and ((Get-Content $watchLogPath -Raw) -match 'renderComplete')) {
            $sawFirstRender = $true; break
        }
        Start-Sleep -Milliseconds 200
    }
    if ($sawFirstRender) {
        Start-Sleep -Milliseconds 300   # let the exit-after timer arm settle before racing it
        Add-Content -Path $watchDoc -Value "`n## Regression Watch Marker"
    }
    $wp.WaitForExit()
    $watchLog = if (Test-Path $watchLogPath) { Get-Content $watchLogPath -Raw } else { '' }

    Check $sawFirstRender 'watcher: first render completes before file is modified'
    Check (([regex]::Matches($watchLog, 'renderComplete')).Count -eq 2) 'watcher: external change triggers exactly one auto-reload' $watchLog
    Check ($watchLog -match 'headings=18') 'watcher: reloaded content reflects the on-disk change' $watchLog
    CheckNoJsErrors ([PSCustomObject]@{ Log = $watchLog }) 'watcher'

}

Add-Scenario 'mermaid-error' {
    # --- 9. a malformed diagram falls back accessibly ---------------------------
    # mermaid.render() rejecting bad syntax is expected and already handled
    # (showDiagramError() swaps in a failure note + the raw source) -- what
    # wasn't checked before is that the <figure> role="img" stamped on it at
    # decorate()-time (assuming a successful render) gets removed on the failure
    # path too. Per the ARIA spec, role="img" makes all descendant content
    # presentational, so leaving it in place would silently hide the fallback
    # note/source from screen readers while a sighted user sees both fine.
    $mermaidErrDoc = Join-Path $work 'mermaid-error.md'
    Set-Content -Path $mermaidErrDoc -Value @'
# Mermaid error test

```mermaid
this is not valid mermaid syntax at all {{{ ]][[
```
'@ -NoNewline
    $r = Run $mermaidErrDoc @() 'mermaid-error'
    Check ($r.ExitCode -eq 0) 'mermaid-error: clean exit'
    Check ($r.Log -match 'diagramErrorProbe.*role=null') 'mermaid-error: role="img" removed from the failed diagram (screen readers can reach the fallback text)' $r.Log
    Check ($r.Log -match 'diagramErrorProbe.*hasNote=true.*hasSource=true') 'mermaid-error: failure note and raw source are both present' $r.Log
    CheckNoJsErrors $r 'mermaid-error'

}

Add-Scenario 'editortest' {
    # --- 10. write-mode toolbar formatting actions -------------------------------
    # A scratch document, not demo.md: the clipboard-image-paste test writes a
    # real file next to whatever document is open (g_docDir), and demo.md's
    # folder is this project's own assets/ — not somewhere a test run should be
    # leaving generated pasted-image-*.png files behind.
    # The body line's mixed-case "fox" text is a holdover from search checks
    # that have since migrated to tests/specs/find-case.spec.mjs (tests/MIGRATION.md)
    # -- kept as-is since it's harmless scratch content, not because anything
    # below still depends on it.
    $editorTestDoc = Join-Path $work 'editortest.md'
    Set-Content -Path $editorTestDoc -Value "# Editor test scratch doc`n`none Fox two fox three FOX four`n" -NoNewline
    # A real, in-bounds media file the __abs__/ resource-loader security checks
    # (below) use as a positive control -- MimeForExt() is a media-only
    # whitelist, so editortest.md itself (not media) can't serve as one; a tiny
    # valid 1x1 PNG can.
    $editorTestProbeImg = Join-Path $work 'editortest-probe.png'
    [IO.File]::WriteAllBytes($editorTestProbeImg, [Convert]::FromBase64String(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='))
    # A real media file OUTSIDE g_docDir (a dedicated sibling folder, one level
    # up from mdview-regression, kept separate so it doesn't mix into the
    # user's real %TEMP% root) -- the __abs__/ path-traversal check's target.
    # Deliberately a media extension, not editortest.md's own, so the check
    # exercises IsSafeLocalPath()'s g_docDir confinement specifically rather
    # than being incidentally shielded by MimeForExt()'s separate media-only
    # whitelist (a real system file like win.ini would be shielded that way,
    # masking whether the confinement check itself still works).
    $travTargetDir = Join-Path (Split-Path $work -Parent) 'mdview-regression-outside'
    New-Item -ItemType Directory -Force $travTargetDir | Out-Null
    $travTargetImg = Join-Path $travTargetDir 'mdv-traversal-target.png'
    [IO.File]::WriteAllBytes($travTargetImg, [Convert]::FromBase64String(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='))
    # --mdv-trav-dir= forwards THIS variable's own leaf name into the page as
    # BOOT.travDir (app.js), so this is the only place that name is ever spelled
    # out -- renaming $travTargetDir here now automatically renames what the
    # traversal-check probe URL targets too, instead of needing a second,
    # independently hardcoded literal in app.js kept in sync by hand.
    $r = Run $editorTestDoc @('--mdv-editor-test', "--mdv-trav-dir=$(Split-Path $travTargetDir -Leaf)") 'editortest'
    Check ($r.Log -match 'editorTestComplete') 'editortest: self-test runs'
    Check ($r.Log -match 'failures=0') 'editortest: native-only checks (defense-in-depth, __abs__/UNC guard, saveClipboardImage) all pass' $r.Log
    CheckNoJsErrors $r 'editortest'

    # debugRunNativeTest() (assets/app.js -- everything reachable through the
    # Playwright harness moved out to tests/specs/*.spec.mjs/tests/node/*.test.mjs
    # per tests/MIGRATION.md) pastes a clipboard image via a real, non-stubbed
    # saveClipboardImage->insertImage round trip; insertAtCaret()'s underlying
    # replaceRange() calls setDirty(true) unconditionally, so this is still a
    # real editor.value change reaching native as a real postMessage, not a
    # debug-only injection hook (dirty-race/save-suppression) or a directly-
    # assigned JS variable that never calls setDirty() at all. main.cpp's
    # "dirty" message handler -- and its downstream UpdateTitle() call, and the
    # actual native window-title string that produces -- had never been
    # verified end to end; this rides on a check that already exists rather
    # than adding a new one, and confirms the full real pipeline: real edit -> real
    # postMessage -> native message parsing -> g_dirty -> the actual window title
    # showing the bullet marker for unsaved changes.
    Check ($r.Log -match 'dirty-message: on=1 title="• editortest\.md') 'editortest: a real (non-stubbed) edit''s dirty message genuinely updates native state and the window title shows the unsaved-changes marker' $r.Log

    # Same reasoning, the direct parallel: enterEdit() (needed before the
    # saveClipboardImage checks below can insert into the editor) posts a real,
    # non-stubbed {type:'editing', on:'1'} -- g_editing is the OTHER half of the
    # exact gate dirty-race/save-suppression verify given a correct value, but
    # (like g_dirty before this pass) had never been confirmed reachable via the
    # real message path, only via debug injection or a directly-assigned JS
    # variable.
    Check ($r.Log -match 'editing-message: on=1') 'editortest: entering edit mode for real (non-stubbed) genuinely sends the editing message and updates native g_editing' $r.Log

    # openExternal's scheme allowlist (main.cpp) is a real security guard --
    # only http(s)/mailto URLs reach ShellExecuteW, everything else (javascript:,
    # file:, a registered custom protocol handler...) is rejected. The real
    # link-click handler in app.js already filters hrefs before ever posting
    # this message, so native's OWN independent check is defense-in-depth --
    # only reachable by a message that bypasses that filter, e.g. a
    # compromised/buggy renderer rather than a real click. Deliberately posts a
    # REAL (non-stubbed) message with a hostile URL and checks ONLY the
    # rejection path; the allowed branch genuinely launches the user's default
    # browser, a real disruptive side effect no automated test should trigger.
    Check ($r.Log -match 'openExternal: rejected \(unsupported scheme\) url="javascript:alert\(1\)"') 'editortest: openExternal''s native scheme check independently rejects a hostile URL, even bypassing the JS-side filter (defense in depth)' $r.Log

}

Add-Scenario 'multi-instance' {
    # --- 11. a second instance never sweeps the first's shared profile ----------
    # SweepTempProfile() deletes the whole shared WebView2 profile directory on
    # startup (stale-lock cleanup) -- gated on g_solo specifically so a second
    # instance launched while a first is still alive can never delete a profile
    # the first one is actively using underneath it. This mechanism was
    # previously invisible in any log (nothing recorded g_solo's value) and had
    # never actually been exercised: every other scenario in this suite runs
    # exactly one instance at a time. Uses the real named mutex, two real
    # concurrent processes -- not a simulation of the logic. Deliberately does
    # NOT use the shared Run helper for instance B: Run's own first action is an
    # unconditional `Remove-Item -Recurse -Force` on the shared profile
    # directory, which would corrupt instance A's still-live session -- exactly
    # the corruption g_solo exists to prevent the app itself from causing, so
    # the test harness must not cause it either.
    Get-Process MDView.debug -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $soloDoc = Join-Path $work 'solo-a.md'
    Set-Content -Path $soloDoc -Value "# Instance A`n" -NoNewline
    $soloLogA = Join-Path $work 'solo-a.log'
    $soloLogB = Join-Path $work 'solo-b.log'
    Remove-Item $soloLogA, $soloLogB -ErrorAction SilentlyContinue
    $soloA = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$soloLogA",
        '--mdv-timeout=60000', '--mdv-exit-after=3000', $soloDoc) -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(10)
    $sawInstanceA = $false
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $soloLogA) -and ((Get-Content $soloLogA -Raw) -match 'instance:')) { $sawInstanceA = $true; break }
        Start-Sleep -Milliseconds 100
    }
    # A's mutex is held by the time it's logged its own instance line -- safe for
    # B to start now and be guaranteed to see it. B never touches the profile
    # directory itself (no cleanup step here); it only reads whatever A already
    # created, same as the app's own SweepTempProfile() would (it just returns
    # immediately once it sees g_solo is false).
    Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$soloLogB",
        '--mdv-timeout=60000', '--mdv-exit-after=800', $soloDoc) -Wait -WindowStyle Hidden
    $soloA.WaitForExit()
    $soloLogAText = if (Test-Path $soloLogA) { Get-Content $soloLogA -Raw } else { '' }
    $soloLogBText = if (Test-Path $soloLogB) { Get-Content $soloLogB -Raw } else { '' }

    Check $sawInstanceA 'multi-instance: first instance starts and logs its own state'
    Check ($soloLogAText -match 'instance: solo \(first/only\)') 'multi-instance: the first instance correctly sees itself as solo' $soloLogAText
    Check ($soloLogBText -match 'instance: not solo') 'multi-instance: a second instance launched while the first is alive correctly detects it is NOT solo' $soloLogBText
    CheckNoJsErrors ([PSCustomObject]@{ Log = $soloLogAText }) 'multi-instance (instance A)'
    CheckNoJsErrors ([PSCustomObject]@{ Log = $soloLogBText }) 'multi-instance (instance B)'

}

Add-Scenario 'utf16' {
    # --- 12. UTF-16-encoded documents open correctly (not misidentified as binary)
    # LooksBinary() (main.cpp) scans a document's raw bytes for a null byte
    # before NormalizeToUtf8 ever gets a chance to decode UTF-16 -- but a genuine
    # UTF-16 text file is roughly half null bytes by construction (every other
    # byte of any ASCII-range content), which used to trip that heuristic and
    # reject a perfectly valid document (e.g. one saved by Notepad's default
    # "Unicode" option, or many Windows tools' default text encoding) as "That
    # file looks like a binary file, not a text document." -- even though
    # NormalizeToUtf8 has an explicit, previously-dead-code UTF-16 decode path
    # for exactly this case. Fixed by trusting the same UTF-16 BOM markers
    # NormalizeToUtf8 already trusts for decoding. Covers both endiannesses, plus
    # confirms a genuinely binary file is still correctly rejected (no
    # regression from loosening the check).
    $utf16leDoc = Join-Path $work 'utf16le.md'
    $utf16beDoc = Join-Path $work 'utf16be.md'
    $genuineBinDoc = Join-Path $work 'genuine-binary.md'
    $utf16Body = "# UTF-16 Test`n`nPlain markdown body."
    [System.IO.File]::WriteAllBytes($utf16leDoc, [byte[]](0xFF,0xFE) + [System.Text.Encoding]::Unicode.GetBytes($utf16Body))
    [System.IO.File]::WriteAllBytes($utf16beDoc, [byte[]](0xFE,0xFF) + [System.Text.Encoding]::BigEndianUnicode.GetBytes($utf16Body))
    $rndBytes = New-Object byte[] 2000
    (New-Object Random).NextBytes($rndBytes)
    $rndBytes[0] = 0x00 # guarantee a null byte lands in LooksBinary's probe window
    [System.IO.File]::WriteAllBytes($genuineBinDoc, $rndBytes)

    $r = Run $utf16leDoc @() 'utf16le'
    Check ($r.Log -notmatch 'could not open') 'utf16: a UTF-16LE document is not misidentified as binary' $r.Log
    Check ($r.Log -match 'handing off doc=' -and $r.Log -notmatch 'handing off doc=\(none\)') 'utf16: UTF-16LE document actually loads' $r.Log
    Check ($r.Log -match '\[js:domSummary\].*headings=1') 'utf16: UTF-16LE document content decodes and renders correctly' $r.Log
    Check ($r.Log -match 'doc-info: encoding="UTF-16 LE"') 'utf16: SendDocMsg reports encoding="UTF-16 LE"' $r.Log
    CheckNoJsErrors $r 'utf16le'

    $r = Run $utf16beDoc @() 'utf16be'
    Check ($r.Log -notmatch 'could not open') 'utf16: a UTF-16BE document is not misidentified as binary' $r.Log
    Check ($r.Log -match 'handing off doc=' -and $r.Log -notmatch 'handing off doc=\(none\)') 'utf16: UTF-16BE document actually loads' $r.Log
    Check ($r.Log -match '\[js:domSummary\].*headings=1') 'utf16: UTF-16BE document content decodes and renders correctly' $r.Log
    Check ($r.Log -match 'doc-info: encoding="UTF-16 BE"') 'utf16: SendDocMsg reports encoding="UTF-16 BE"' $r.Log
    CheckNoJsErrors $r 'utf16be'

    $r = Run $genuineBinDoc @() 'genuine-binary'
    Check ($r.Log -match 'could not open') 'utf16: a genuinely binary file is still correctly rejected (no regression)' $r.Log

}

Add-Scenario 'corrupt-ads' {
    # --- 13. corrupted persisted-preference (NTFS ADS) data doesn't crash or hang
    # LoadWindowAds()/LoadSettingsBlob() (main.cpp) read window placement and
    # JS-owned settings JSON from NTFS alternate data streams on the exe itself
    # (see mdviewer-project memory) -- state that lives outside any document and
    # could in principle get corrupted (a crash mid-write, disk corruption, a
    # stream truncated by some external tool) independently of anything this
    # suite's other scenarios exercise. Verified against a SEPARATE COPY of the
    # exe, never the real out\MDView.debug.exe used by every other scenario in
    # this suite -- corrupting ITS real persisted prefs here would taint every
    # other test's window-placement/theme/zoom state for the rest of this run
    # and beyond. Re-copied fresh every run so it can never go stale after a
    # rebuild. Covers malformed settings JSON (truncated mid-token), raw binary
    # garbage in the settings stream, and a garbage (non-numeric) window
    # placement string, all applied together as the worst realistic case.
    $adsExe = Join-Path $work 'corrupt-ads-test.exe'
    Copy-Item -Path $exe -Destination $adsExe -Force
    $rndSettings = New-Object byte[] 300
    (New-Object Random).NextBytes($rndSettings)
    [System.IO.File]::WriteAllBytes("$adsExe`:mdv.settings", $rndSettings)
    Set-Content -Path $adsExe -Stream 'mdv.window' -Value 'not even close to the expected format' -NoNewline
    $adsDoc = Join-Path $work 'corrupt-ads-doc.md'
    Set-Content -Path $adsDoc -Value "# Corrupt ADS test`n`nBody text.`n" -NoNewline
    Get-Process 'corrupt-ads-test' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $adsLog = Join-Path $work 'corrupt-ads.log'
    Remove-Item $adsLog -ErrorAction SilentlyContinue
    $adsArgs = @('--mdv-headless', "--mdv-log=$adsLog", '--mdv-timeout=60000', '--mdv-exit-after=800', $adsDoc)
    $adsP = Start-Process -FilePath $adsExe -ArgumentList $adsArgs -PassThru -Wait -WindowStyle Hidden
    $adsLogText = if (Test-Path $adsLog) { Get-Content $adsLog -Raw } else { '' }

    Check ($adsP.ExitCode -eq 0) 'corrupt-ads: clean exit despite corrupted persisted preference data'
    Check ($adsLogText -match 'window rect .* havePlacement=0') 'corrupt-ads: garbage window placement is discarded, falls back to default geometry' $adsLogText
    Check ($adsLogText -match '\[js:domSummary\].*headings=1') 'corrupt-ads: document still renders correctly despite corrupted settings blob' $adsLogText
    CheckNoJsErrors ([PSCustomObject]@{ Log = $adsLogText }) 'corrupt-ads'

}

Add-Scenario 'crash-forensics' {
    # --- 14. crash-forensics handlers (CrashHandler/TerminateHandler) actually work
    # main.cpp installs SetUnhandledExceptionFilter(CrashHandler) and
    # std::set_terminate(TerminateHandler) at startup specifically so a real
    # crash leaves a forensic trail (exception code/address, doc/dirty/editing
    # state) in the log instead of vanishing into Windows Error Reporting (which
    # this app disables) with nothing to go on afterward. Neither handler was
    # ever exercised by any scenario in this suite -- a bug in the handler
    # itself (a bad format string, AppendLog throwing, wrong log-line content)
    # would have gone completely unnoticed. --mdv-crash-test=seh/terminate
    # (debug-only) deliberately triggers each path for real once the page is
    # ready, rather than simulating what the handler "should" log.
    $crashDoc = Join-Path $work 'crash-test-doc.md'
    Set-Content -Path $crashDoc -Value "# Crash handler test`n`nBody text.`n" -NoNewline

    Get-Process MDView.debug -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $crashLogSeh = Join-Path $work 'crash-seh.log'
    Remove-Item $crashLogSeh -ErrorAction SilentlyContinue
    $crashSehP = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$crashLogSeh",
        '--mdv-timeout=15000', '--mdv-crash-test=seh', $crashDoc) -PassThru -Wait -WindowStyle Hidden
    $crashSehLog = if (Test-Path $crashLogSeh) { Get-Content $crashLogSeh -Raw } else { '' }
    Check ($crashSehP.ExitCode -eq -1073741819) 'crash-handler: a genuine access violation terminates the process with the expected exception code (not a hang)' "exit=$($crashSehP.ExitCode)"
    Check ($crashSehLog -match 'UNHANDLED EXCEPTION code=0xC0000005 addr=[0-9A-Fa-f]+ base=[0-9A-Fa-f]+ rva=0x[0-9A-Fa-f]+ doc=.*crash-test-doc\.md') 'crash-handler: CrashHandler() logs the exception code, address, module base, RVA, and real document state' $crashSehLog

    Get-Process MDView.debug -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $crashLogTerm = Join-Path $work 'crash-terminate.log'
    Remove-Item $crashLogTerm -ErrorAction SilentlyContinue
    $crashTermP = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$crashLogTerm",
        '--mdv-timeout=15000', '--mdv-crash-test=terminate', $crashDoc) -PassThru -Wait -WindowStyle Hidden
    $crashTermLog = if (Test-Path $crashLogTerm) { Get-Content $crashLogTerm -Raw } else { '' }
    Check ($crashTermP.ExitCode -ne 0) 'crash-handler: an uncaught C++ exception reaching std::terminate() also terminates the process (not a hang)' "exit=$($crashTermP.ExitCode)"
    Check ($crashTermLog -match 'UNCAUGHT C\+\+ EXCEPTION reached std::terminate\(\)') 'crash-handler: TerminateHandler() logs before the process aborts' $crashTermLog

}

Add-Scenario 'fatal-error' {
    # --- 15. ShowFatalError() never blocks a headless run on a MessageBoxW ------
    # All three real WebView2 init-failure call sites (environment creation
    # failing synchronously, or its completion callback / the controller
    # creation completion callback reporting failure) funnel through
    # ShowFatalError(), whose own comment states exactly why: "A modal dialog
    # blocks forever in a headless/scripted run -- nothing will ever click it".
    # Forcing a REAL WebView2 init failure isn't practical here (it would mean
    # actually breaking the WebView2 runtime this whole suite, and this
    # machine's other software, depends on) -- but ShowFatalError()'s own risk
    # is independent of which caller reached it, so --mdv-fatal-error-test
    # (debug-only) calls it directly once the page is ready, mirroring exactly
    # how a real call site uses it (log, then PostQuitMessage(1)).
    Get-Process MDView.debug -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $fatalDoc = Join-Path $work 'fatal-error-test-doc.md'
    Set-Content -Path $fatalDoc -Value "# Fatal error test`n`nBody text.`n" -NoNewline
    $fatalLog = Join-Path $work 'fatal-error-test.log'
    Remove-Item $fatalLog -ErrorAction SilentlyContinue
    $fatalP = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$fatalLog",
        '--mdv-timeout=15000', '--mdv-fatal-error-test', $fatalDoc) -PassThru -Wait -WindowStyle Hidden
    $fatalLogText = if (Test-Path $fatalLog) { Get-Content $fatalLog -Raw } else { '' }
    Check ($fatalP.ExitCode -eq 1) 'fatal-error: ShowFatalError() exits cleanly (code 1), never hangs behind an unclickable dialog in headless mode' "exit=$($fatalP.ExitCode)"
    Check ($fatalLogText -match 'FATAL: fatal-error-test') 'fatal-error: ShowFatalError() logs the message before quitting' $fatalLogText
    Check (-not ($fatalLogText -match 'WATCHDOG:')) 'fatal-error: the watchdog never has to fire (confirms this is a clean quit, not a stall caught by a safety net)' $fatalLogText

}

Add-Scenario 'dpi-test' {
    # --- 16. WM_DPICHANGED repositions the window exactly per the OS's suggestion
    # Declared PerMonitorV2-aware in app.manifest, so Windows sends WM_DPICHANGED
    # (with a suggested RECT in lParam) whenever the window moves to a monitor
    # with a different DPI. The handler (main.cpp) is a single SetWindowPos call
    # driven entirely by that RECT -- never exercised by any scenario in this
    # suite, and a real monitor/DPI change can't be produced in this
    # single-monitor headless environment. --mdv-dpi-test (debug-only) sends the
    # real message with a distinctive, controlled RECT once the page is ready,
    # so the handler itself runs for real rather than being assumed correct from
    # reading it.
    Get-Process MDView.debug -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $dpiDoc = Join-Path $work 'dpi-test-doc.md'
    Set-Content -Path $dpiDoc -Value "# DPI change test`n`nBody text.`n" -NoNewline
    $dpiLog = Join-Path $work 'dpi-test.log'
    Remove-Item $dpiLog -ErrorAction SilentlyContinue
    $dpiP = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$dpiLog",
        '--mdv-timeout=60000', '--mdv-exit-after=800', '--mdv-dpi-test', $dpiDoc) -PassThru -Wait -WindowStyle Hidden
    $dpiLogText = if (Test-Path $dpiLog) { Get-Content $dpiLog -Raw } else { '' }
    Check ($dpiP.ExitCode -eq 0) 'dpi-change: clean exit after a synthesized WM_DPICHANGED'
    Check ($dpiLogText -match 'dpi-test: suggested=\(111,222,1011,922\) actual=\(111,222,1011,922\)') 'dpi-change: the window is repositioned to EXACTLY the RECT Windows suggested' $dpiLogText
    Check ($dpiLogText -match '\[js:domSummary\].*headings=1') 'dpi-change: the document still renders correctly after the window is repositioned mid-session' $dpiLogText
    CheckNoJsErrors ([PSCustomObject]@{ Log = $dpiLogText }) 'dpi-change'

}

Add-Scenario 'case-dedup' {
    # --- 17. opening the same file via two different casings doesn't duplicate
    #         its recent-files entry -----------------------------------------
    # app.js's updateRecent() (assets/app.js) dedupes purely by exact string
    # equality (`S.recent.filter(r => r.path !== path)`) against whatever path
    # native sends in the "doc" message -- it has no case-insensitive-path logic
    # of its own. The ONLY thing that keeps "open the same file via two
    # differently-cased paths" from producing two recent-files entries is
    # OpenDocument()'s own GetFinalPathNameByHandleW canonicalization (main.cpp),
    # whose comment explicitly names this exact scenario as the reason it
    # exists ("the same file opened once directly and once via a differently-
    # cased relative link produces two distinct path strings, which the plain
    # string comparisons in recent-files dedup ... then treat as two different
    # files"). That native/JS contract had never actually been exercised
    # end-to-end by anything in this suite. Verified against a SEPARATE COPY of
    # the exe (never the real out\MDView.debug.exe, for the same reason as the
    # corrupt-ads scenario) across two sequential real launches sharing that
    # copy's persisted settings (350ms debounced save in app.js, comfortably
    # covered by the exit-after budget below) -- reading the FINAL settings
    # blob back afterward, not simulating what recent-files "should" contain.
    $caseExe = Join-Path $work 'case-dedup-test.exe'
    Copy-Item -Path $exe -Destination $caseExe -Force
    Set-Content -Path $caseExe -Stream 'mdv.settings' -Value '{}' -NoNewline
    $caseDoc = Join-Path $work 'case-dedup-doc.md'
    Set-Content -Path $caseDoc -Value "# Case dedup test`n`nBody text.`n" -NoNewline
    $caseDocUpper = $caseDoc.ToUpper()

    Get-Process 'case-dedup-test' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $caseLog1 = Join-Path $work 'case-dedup-1.log'
    Remove-Item $caseLog1 -ErrorAction SilentlyContinue
    Start-Process -FilePath $caseExe -ArgumentList @('--mdv-headless', "--mdv-log=$caseLog1",
        '--mdv-timeout=60000', '--mdv-exit-after=1500', $caseDoc) -Wait -WindowStyle Hidden | Out-Null

    $caseLog2 = Join-Path $work 'case-dedup-2.log'
    Remove-Item $caseLog2 -ErrorAction SilentlyContinue
    Start-Process -FilePath $caseExe -ArgumentList @('--mdv-headless', "--mdv-log=$caseLog2",
        '--mdv-timeout=60000', '--mdv-exit-after=1500', $caseDocUpper) -Wait -WindowStyle Hidden | Out-Null

    $caseSettingsRaw = Get-Content -Path $caseExe -Stream 'mdv.settings' -Raw -ErrorAction SilentlyContinue
    $caseRecentCount = -1
    $caseParsedOk = $false
    try {
        $caseSettings = $caseSettingsRaw | ConvertFrom-Json
        $caseParsedOk = $true
        $caseMatches = @($caseSettings.recent | Where-Object { $_.path -ieq $caseDoc -or $_.path -ieq $caseDocUpper })
        $caseRecentCount = $caseMatches.Count
    } catch {}

    Check $caseParsedOk 'case-dedup: the persisted settings blob is valid JSON after both opens' $caseSettingsRaw
    Check ($caseRecentCount -eq 1) 'case-dedup: opening the same file via two different path casings produces exactly ONE recent-files entry, not two' "recentCount=$caseRecentCount settings=$caseSettingsRaw"

}

Add-Scenario 'watch-deleted' {
    # --- 18. the file watcher survives the open document being deleted ----------
    # Scenario 8 (watcher) exercises Watcher -> WM_APP_WATCH -> TIMER_RELOAD ->
    # TryAutoReload -> ReloadDoc for a MODIFICATION, the one path through this
    # pipeline this suite otherwise touches. Deleting the open file instead
    # takes a COMPLETELY DIFFERENT branch inside ReloadDoc() -- its own comment
    # names this exact case ("The file was moved or deleted...") with a 4-
    # attempt/60ms retry before giving up -- that branch had never actually been
    # reached by anything in this suite. The watcher itself watches the whole
    # DIRECTORY (FindFirstChangeNotificationW with FILE_NOTIFY_CHANGE_FILE_NAME),
    # so a delete genuinely fires the same notification pipeline a modification
    # does; confirmed this by reading Watcher::Session::Changed() rather than
    # assuming it, then verified it here for real. ReloadDoc()'s failure path
    # returns before ever calling SendDocMsg(), so the discriminating signal is
    # exactly ONE renderComplete in the log (not two, unlike scenario 8) plus a
    # clean exit -- proving the app noticed the deletion, retried, gave up
    # gracefully, and kept running rather than crashing or hanging waiting on a
    # reload that can never succeed.
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $deleteWatchDoc = Join-Path $work 'watch-delete.md'
    Copy-Item $demo $deleteWatchDoc -Force
    $deleteWatchLog = Join-Path $work 'watch-delete.log'
    Remove-Item $deleteWatchLog -ErrorAction SilentlyContinue
    $dwp = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$deleteWatchLog",
        '--mdv-timeout=60000', '--mdv-exit-after=4000', $deleteWatchDoc) -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(55)
    $sawFirstRenderDelete = $false
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $deleteWatchLog) -and ((Get-Content $deleteWatchLog -Raw) -match 'renderComplete')) {
            $sawFirstRenderDelete = $true; break
        }
        Start-Sleep -Milliseconds 200
    }
    if ($sawFirstRenderDelete) {
        Start-Sleep -Milliseconds 300   # let the exit-after timer arm settle before racing it
        Remove-Item $deleteWatchDoc -Force -ErrorAction SilentlyContinue
    }
    $dwp.WaitForExit()
    $deleteWatchLogText = if (Test-Path $deleteWatchLog) { Get-Content $deleteWatchLog -Raw } else { '' }

    Check $sawFirstRenderDelete 'watcher-delete: first render completes before the file is deleted'
    Check ($dwp.ExitCode -eq 0) 'watcher-delete: clean exit after the watched file is deleted out from under it (not a hang, not the watchdog catching a stall)' "exit=$($dwp.ExitCode)"
    Check (([regex]::Matches($deleteWatchLogText, 'renderComplete')).Count -eq 1) 'watcher-delete: the failed reload never posts a second doc/render (ReloadDoc returns before SendDocMsg on a read failure)' $deleteWatchLogText
    Check (-not ($deleteWatchLogText -match 'WATCHDOG:')) 'watcher-delete: the watchdog never has to fire' $deleteWatchLogText
    CheckNoJsErrors ([PSCustomObject]@{ Log = $deleteWatchLogText }) 'watcher-delete'

}

Add-Scenario 'save-no-reload' {
    # --- 19. saving a document never triggers a spurious self-reload ------------
    # SaveDocumentTo() (main.cpp) sets g_suppressWatchUntil = now + 1500ms
    # specifically so the file-system change OUR OWN write causes doesn't get
    # mistaken for an external edit and trigger a pointless reload -- WM_APP_WATCH
    # checks it and no-ops if we're still inside that window. Every existing
    # "saveDoc" check (tests/specs/save-doc.spec.mjs) drives FakeNative, so none
    # of them ever reach real native code at all; this suppression window had never
    # actually been exercised. --mdv-save-test (debug-only) calls
    # SaveDocumentTo() directly once the page is ready, a real disk write through
    # the exact function a real save uses. Verifies BOTH halves: the save itself
    # must NOT trigger a second render within the suppression window, and an
    # ordinary external change AFTER that window must still correctly trigger a
    # reload -- proving this is a genuine time-limited suppression, not e.g. a
    # bug that leaves the watcher permanently wedged off after any save.
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $saveDoc = Join-Path $work 'save-test-doc.md'
    Set-Content -Path $saveDoc -Value "# Save suppression test`n`nBody text.`n" -NoNewline
    $saveLog = Join-Path $work 'save-test.log'
    Remove-Item $saveLog -ErrorAction SilentlyContinue
    $sp = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$saveLog",
        '--mdv-timeout=60000', '--mdv-exit-after=6000', '--mdv-save-test', $saveDoc) -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(55)
    $sawSave = $false
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $saveLog) -and ((Get-Content $saveLog -Raw) -match 'save-test: SaveDocumentTo')) {
            $sawSave = $true; break
        }
        Start-Sleep -Milliseconds 100
    }
    $renderCountAfterSave = -1
    if ($sawSave) {
        # g_suppressWatchUntil is a 1500ms window from the moment of the save --
        # wait comfortably past it (but well before --mdv-exit-after) and confirm
        # no second render snuck in during that window specifically, before
        # making the later, deliberately-NOT-suppressed external change below.
        Start-Sleep -Milliseconds 2000
        $renderCountAfterSave = ([regex]::Matches((Get-Content $saveLog -Raw), 'renderComplete')).Count
        Add-Content -Path $saveDoc -Value "`n## Post-suppression marker"
    }
    $sp.WaitForExit()
    $saveLogText = if (Test-Path $saveLog) { Get-Content $saveLog -Raw } else { '' }
    $finalRenderCount = ([regex]::Matches($saveLogText, 'renderComplete')).Count

    Check $sawSave 'save-suppression: the direct native save actually happens' $saveLogText
    Check ($renderCountAfterSave -eq 1) 'save-suppression: our own save does NOT trigger a second render within the 1500ms suppression window' "renderCountAfterSave=$renderCountAfterSave"
    Check ($finalRenderCount -eq 2) 'save-suppression: an ordinary external change AFTER the suppression window still correctly triggers a reload (suppression is time-limited, not permanently stuck)' "finalRenderCount=$finalRenderCount"
    Check (-not ($saveLogText -match 'WATCHDOG:')) 'save-suppression: the watchdog never has to fire' $saveLogText
    CheckNoJsErrors ([PSCustomObject]@{ Log = $saveLogText }) 'save-suppression'

}

Add-Scenario 'dirty-race' {
    # --- 20. an edit landing during the 150ms reload debounce is NOT blown away
    # TryAutoReload() (main.cpp) re-checks g_dirty/g_editing fresh at TIMER_RELOAD
    # fire time rather than only when the change notification first arrived --
    # scenario 8's own comment names exactly why (a reader who starts editing
    # during the 150ms debounce must not have their in-progress edit destroyed
    # by an auto-reload) and explicitly flags this as NOT exercised, "needs
    # precise timing injection this harness doesn't have yet". Rather than
    # chase real-world timing luck (a genuine race is inherently flaky to hit on
    # demand), --mdv-dirty-on-watch (debug-only) sets g_dirty = true INSIDE the
    # WM_APP_WATCH handler itself, deterministically landing in the exact
    # 150ms window every run regardless of real-world scheduling jitter --
    # precise injection, not a simulation of what TryAutoReload "should" do.
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $raceDoc = Join-Path $work 'dirty-race-doc.md'
    Set-Content -Path $raceDoc -Value "# Dirty race test`n`nBody text.`n" -NoNewline
    $raceLog = Join-Path $work 'dirty-race.log'
    Remove-Item $raceLog -ErrorAction SilentlyContinue
    $rp = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$raceLog",
        '--mdv-timeout=60000', '--mdv-exit-after=4000', '--mdv-dirty-on-watch', $raceDoc) -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(55)
    $sawFirstRenderRace = $false
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $raceLog) -and ((Get-Content $raceLog -Raw) -match 'renderComplete')) {
            $sawFirstRenderRace = $true; break
        }
        Start-Sleep -Milliseconds 200
    }
    if ($sawFirstRenderRace) {
        Start-Sleep -Milliseconds 300   # let the exit-after timer arm settle before racing it
        Add-Content -Path $raceDoc -Value "`n## External marker (should be ignored -- dirty at fire time)"
    }
    $rp.WaitForExit()
    $raceLogText = if (Test-Path $raceLog) { Get-Content $raceLog -Raw } else { '' }

    Check $sawFirstRenderRace 'dirty-race: first render completes before the external change'
    Check ($raceLogText -match 'dirty-on-watch: g_dirty set true') 'dirty-race: the injection precisely lands inside the 150ms debounce window' $raceLogText
    Check (([regex]::Matches($raceLogText, 'renderComplete')).Count -eq 1) 'dirty-race: an edit landing during the debounce correctly SUPPRESSES the auto-reload (TryAutoReload''s fresh re-check protects it)' $raceLogText
    Check ($rp.ExitCode -eq 0) 'dirty-race: clean exit' "exit=$($rp.ExitCode)"
    CheckNoJsErrors ([PSCustomObject]@{ Log = $raceLogText }) 'dirty-race'

}

Add-Scenario 'unhandled-rejection' {
    # --- 21. the 'unhandledrejection' listener genuinely feeds [js:error] -------
    # Every single "no uncaught JS errors" check across this ENTIRE suite (every
    # scenario above, CheckNoJsErrors) relies on window.addEventListener(
    # 'unhandledrejection', ...) in app.js forwarding into the exact same
    # [js:error] log line the synchronous 'error' listener uses -- but nothing
    # had ever deliberately triggered THIS listener specifically to confirm it
    # actually does. If it were ever broken (a browser API change, an
    # accidentally-deleted line), an entire class of real bugs -- any async/
    # Promise-based failure anywhere in this app -- would silently pass every
    # "no JS errors" check in this whole suite without any of them noticing.
    # --mdv-rejection-test (debug-only) creates a genuinely unhandled Promise
    # rejection (no .catch() anywhere) once the page is ready, a real async
    # failure, not a simulated one.
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $rejectDoc = Join-Path $work 'rejection-test-doc.md'
    Set-Content -Path $rejectDoc -Value "# Rejection test`n`nBody text.`n" -NoNewline
    $r = Run $rejectDoc @('--mdv-rejection-test') 'rejection-test'
    Check ($r.ExitCode -eq 0) 'rejection-test: clean exit despite the deliberate unhandled rejection'
    Check ($r.Log -match '\[js:error\] unhandledrejection: Error: rejection-test: deliberate unhandledrejection probe') 'rejection-test: the unhandledrejection listener genuinely forwards into [js:error], the same signal every other scenario''s "no JS errors" check depends on' $r.Log

}

Add-Scenario 'minimize-test' {
    # --- 22. WM_SIZE's minimize/restore transition (WebView2 visibility+bounds)
    # Every OTHER scenario in this suite keeps its window off-screen rather than
    # minimized, specifically because a minimized/hidden window's Page
    # Visibility API throttles the timers the progressive renderer's own pacing
    # depends on (see SLICE_BUDGET_MS's comment in app.js) -- so WM_SIZE's
    # SIZE_MINIMIZED branch (hides the WebView2 controller via
    # put_IsVisible(FALSE), restores visibility+bounds on un-minimize) had never
    # been reached by anything in this suite. --mdv-minimize-test (debug-only)
    # triggers a real, brief minimize/restore cycle via genuine ShowWindow calls
    # -- deliberately AFTER the render completes, not before, so this tests the
    # WM_SIZE geometry transition itself rather than throttling recovery.
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $minimizeDoc = Join-Path $work 'minimize-test-doc.md'
    Set-Content -Path $minimizeDoc -Value "# Minimize test`n`nBody text.`n" -NoNewline
    $r = Run $minimizeDoc @('--mdv-minimize-test') 'minimize-test'
    Check ($r.ExitCode -eq 0) 'minimize-test: clean exit after a real minimize/restore cycle'
    Check ($r.Log -match 'minimize-test: WM_SIZE\(SIZE_MINIMIZED\), controller hidden') 'minimize-test: minimizing genuinely hides the WebView2 controller' $r.Log
    Check ($r.Log -match 'minimize-test: WM_SIZE\(restored\), controller visible, bounds set') 'minimize-test: restoring genuinely re-shows the controller and re-applies bounds' $r.Log
    CheckNoJsErrors $r 'minimize-test'

    Write-Host ''

}

Add-Scenario 'minmax-test' {
    # --- 23. WM_GETMINMAXINFO's real, DPI-scaled minimum window size
    # WM_SIZE's minimize/restore branch (previous scenario) was the last WM_*
    # case worth exercising among the ones this suite deliberately avoided for
    # on-screen-disruption reasons -- but WM_GETMINMAXINFO (enforces the app's
    # real minimum resizable window size, 420x320 DIPs, scaled per-monitor DPI)
    # was simply never checked at all, by anything. Unlike minimize/restore,
    # this needs zero on-screen disruption to test: --mdv-minmax-test sends the
    # real WM_GETMINMAXINFO message directly (the same message Windows sends
    # during an interactive resize-drag) and logs the MINMAXINFO the real
    # handler actually filled in, alongside an independently-computed expected
    # value using the same DPI-scaling formula -- if the two ever diverge
    # (someone changes one of the two literal 420/320 constants and not the
    # other, or the DPI-scaling math regresses), this catches it directly.
    $minmaxDoc = Join-Path $work 'minmax-test-doc.md'
    Set-Content -Path $minmaxDoc -Value "# MinMax test`n`nBody text.`n" -NoNewline
    $r = Run $minmaxDoc @('--mdv-minmax-test') 'minmax-test'
    Check ($r.ExitCode -eq 0) 'minmax-test: clean exit'
    $m = [regex]::Match($r.Log, 'minmax-test: dpi=(\d+) minTrack=\((\d+),(\d+)\) expected=\((\d+),(\d+)\)')
    Check ($m.Success -and $m.Groups[2].Value -eq $m.Groups[4].Value -and $m.Groups[3].Value -eq $m.Groups[5].Value) 'minmax-test: the real WM_GETMINMAXINFO handler enforces exactly the DPI-scaled 420x320 minimum, not a stale or divergent value' $r.Log
    CheckNoJsErrors $r 'minmax-test'

    Write-Host ''

}

Add-Scenario 'unicode-filename' {
    # --- 24. a real Unicode filename (accented Latin + CJK + emoji) round-trips
    # Every scratch document filename anywhere in this whole suite -- all 23
    # prior scenarios -- is plain ASCII. That leaves a genuinely fresh, never-
    # exercised surface: the app's own title bar (UpdateTitle -> g_docName ->
    # SetWindowTextW) and its recent-files persistence (JsonEscape -> the ADS
    # settings blob -> JSON.parse on the JS side) both handle whatever Unicode
    # is actually in a real filename, including a case JsonGetString's own
    # \uXXXX-escape decoder was never exercised against: a non-BMP character
    # (an emoji), which JSON represents as a UTF-16 surrogate PAIR. This is a
    # different surface from the earlier UTF-16 bug fix (that was about a
    # document's on-disk CONTENT encoding; this is about the file PATH/NAME,
    # an entirely separate code path). A debug-only title-now log line
    # (added alongside this scenario, fires on every real UpdateTitle() call)
    # makes the actual title observable; the persisted settings blob makes
    # the recent-files round-trip observable, the same pattern case-dedup
    # (scenario 17) already established.
    $unicodeExe = Join-Path $work 'unicode-path-test.exe'
    Copy-Item -Path $exe -Destination $unicodeExe -Force
    Set-Content -Path $unicodeExe -Stream 'mdv.settings' -Value '{}' -NoNewline
    $unicodeDoc = Join-Path $work 'café-文档-😀-test.md'
    Set-Content -Path $unicodeDoc -Value "# Unicode filename test`n`nBody text.`n" -NoNewline -Encoding UTF8

    Get-Process 'unicode-path-test' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $unicodeLog = Join-Path $work 'unicode-path.log'
    Remove-Item $unicodeLog -ErrorAction SilentlyContinue
    Start-Process -FilePath $unicodeExe -ArgumentList @('--mdv-headless', "--mdv-log=$unicodeLog",
        '--mdv-timeout=60000', '--mdv-exit-after=1500', $unicodeDoc) -Wait -WindowStyle Hidden

    $unicodeLogText = Get-Content -Path $unicodeLog -Raw -Encoding UTF8
    Check ($unicodeLogText -notmatch 'openFailed') 'unicode-filename: a real Unicode (accented + CJK + emoji) filename opens without being misidentified or rejected' $unicodeLogText
    Check ($unicodeLogText -match [regex]::Escape('title-now: "café-文档-😀-test.md — MD Viewer"')) 'unicode-filename: the window title genuinely displays the correct Unicode filename, including the emoji surrogate pair' $unicodeLogText
    Check ($unicodeLogText -match '\[js:renderComplete\]') 'unicode-filename: the document still renders' $unicodeLogText
    Check ($unicodeLogText -notmatch '\[js:error\]') 'unicode-filename: no uncaught JS errors'

    $unicodeSettingsRaw = Get-Content -Path $unicodeExe -Stream 'mdv.settings' -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    $unicodeRecentOk = $false
    try {
        $unicodeSettings = $unicodeSettingsRaw | ConvertFrom-Json
        $unicodeRecentOk = @($unicodeSettings.recent | Where-Object { $_.path -eq $unicodeDoc -and $_.name -eq 'café-文档-😀-test.md' }).Count -eq 1
    } catch {}
    Check $unicodeRecentOk 'unicode-filename: the recent-files ADS settings blob round-trips the real Unicode path and name exactly' $unicodeSettingsRaw

    Write-Host ''

}

Add-Scenario 'chrome-test' {
    # --- 25. the "chrome" message's real DWM dark-mode attribute
    # applyPrefs() (app.js) posts a real, non-stubbed {type:'chrome'} message
    # unconditionally at page load -- meaning ApplyChrome()'s
    # DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE) call has actually
    # fired on every single run of every scenario in this whole suite, but
    # nothing has ever read the attribute back to confirm it actually landed
    # rather than silently no-op'ing (wrong attribute id, an unsupported OS
    # build, an ignored HRESULT). Forces both directions explicitly via a
    # pre-seeded settings ADS (theme:"light"/"dark") rather than relying on
    # whatever theme this machine's own OS happens to be in.
    $chromeExe = Join-Path $work 'chrome-test.exe'
    Copy-Item -Path $exe -Destination $chromeExe -Force
    $chromeDoc = Join-Path $work 'chrome-test-doc.md'
    Set-Content -Path $chromeDoc -Value "# Chrome test`n`nBody text.`n" -NoNewline

    Get-Process 'chrome-test' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    Set-Content -Path $chromeExe -Stream 'mdv.settings' -Value '{"theme":"dark"}' -NoNewline
    $chromeDarkLog = Join-Path $work 'chrome-dark.log'
    Remove-Item $chromeDarkLog -ErrorAction SilentlyContinue
    Start-Process -FilePath $chromeExe -ArgumentList @('--mdv-headless', "--mdv-log=$chromeDarkLog",
        '--mdv-timeout=60000', '--mdv-exit-after=1000', $chromeDoc) -Wait -WindowStyle Hidden
    $chromeDarkText = Get-Content -Path $chromeDarkLog -Raw
    Check ($chromeDarkText -match 'chrome-message: dark=1 hr=0x00000000 actual=1') 'chrome-test: theme:"dark" genuinely sets the real DWM dark-title-bar attribute (read back, not assumed)' $chromeDarkText

    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    Set-Content -Path $chromeExe -Stream 'mdv.settings' -Value '{"theme":"light"}' -NoNewline
    $chromeLightLog = Join-Path $work 'chrome-light.log'
    Remove-Item $chromeLightLog -ErrorAction SilentlyContinue
    Start-Process -FilePath $chromeExe -ArgumentList @('--mdv-headless', "--mdv-log=$chromeLightLog",
        '--mdv-timeout=60000', '--mdv-exit-after=1000', $chromeDoc) -Wait -WindowStyle Hidden
    $chromeLightText = Get-Content -Path $chromeLightLog -Raw
    Check ($chromeLightText -match 'chrome-message: dark=0 hr=0x00000000 actual=0') 'chrome-test: theme:"light" genuinely clears the real DWM dark-title-bar attribute' $chromeLightText
    Check ($chromeDarkText -notmatch '\[js:error\]') 'chrome-test (dark): no uncaught JS errors'
    Check ($chromeLightText -notmatch '\[js:error\]') 'chrome-test (light): no uncaught JS errors'

    Write-Host ''

}

Add-Scenario 'persist-profile' {
    # --- 26. --mdv-persist-profile genuinely skips the profile sweep and cleanup
    # The very first bug fixed this whole session (the CLI-argument-parsing
    # ordering fix, before this suite even had a numbered increment log) was
    # specifically that this flag was silently non-functional -- but nothing
    # ever locked that fix in with a permanent check afterward; the flag is
    # passed by zero scenarios anywhere else in this suite. Deliberately tests
    # ONLY the fully deterministic half of the claim: with the flag set,
    # DestroyWindow() (main.cpp) returns before ever calling the WebView2
    # profile's own Profile.Delete(), so the directory's continued existence
    # is immediate and certain, not an async race. The REVERSE claim (a
    # normal run eventually cleans its own profile up) is deliberately NOT
    # tested here via wall-clock timing -- Profile.Delete() is WebView2's own
    # async API, and SweepTempProfile()'s own comment documents this can take
    # up to ~1s after the process exits; asserting "gone by time X" would be
    # exactly the flaky real-world-timing check this suite avoids elsewhere
    # in favor of deterministic ones (confirmed empirically while designing
    # this check: even 2s after a normal run's exit, the directory was still
    # present, populated -- an async-cleanup-latency characteristic, not a bug,
    # already implicitly acknowledged by every OTHER scenario's own defensive
    # pre-clean of this exact directory before it runs).
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $persistDoc = Join-Path $work 'persist-profile-doc.md'
    Set-Content -Path $persistDoc -Value "# Persist profile test`n`nBody text.`n" -NoNewline
    $r = Run $persistDoc @('--mdv-persist-profile') 'persist-profile'
    Check ($r.ExitCode -eq 0) 'persist-profile: clean exit'
    Check ($r.Log -match 'profile sweep skipped \(--mdv-persist-profile\)') 'persist-profile: the startup sweep is genuinely skipped when the flag is set' $r.Log
    $persistFileCount = (Get-ChildItem "$env:TEMP\MDView.debug.wv2" -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Check ($persistFileCount -gt 0) 'persist-profile: the real WebView2 profile directory genuinely survives, populated, after the process exits' "fileCount=$persistFileCount"
    CheckNoJsErrors $r 'persist-profile'
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue

    Write-Host ''

}

Add-Scenario 'screenshot-test' {
    # --- 27. --mdv-screenshot alone (no --mdv-exit-after) must still terminate
    # A REAL BUG, found while investigating why --mdv-screenshot -- like
    # --mdv-persist-profile before it -- had zero coverage in this suite: every
    # OTHER scenario's use of the shared Run() helper always includes
    # --mdv-exit-after=800 automatically, silently masking that
    # --mdv-screenshot alone (the exact combination README.md's own flag table
    # documents as a standalone, valid PATH-only flag) hung for the FULL
    # watchdog timeout before being force-killed -- ArmDebugExitTimer()
    # (main.cpp) only armed the exit timer `if (g_debugExitAfterMs >= 0)`, so
    # an unset --mdv-exit-after (its default, -1) meant a screenshot-only run
    # never armed anything at all once the screenshot itself finished. Fixed:
    # an unset exit-after now means "exit immediately" (std::max(0, -1) == 0),
    # not "never" -- ArmDebugExitTimer() is only ever reachable from a
    # --mdv-headless run (CaptureDebugScreenshot's callers all gate on it), so
    # defaulting to an immediate exit there is always correct. Deliberately
    # bypasses Run() here, which would mask the exact bug this exists to catch
    # by always supplying --mdv-exit-after itself.
    $screenshotDoc = Join-Path $work 'screenshot-doc.md'
    Set-Content -Path $screenshotDoc -Value "# Screenshot test`n`nBody text.`n" -NoNewline
    $screenshotPng = Join-Path $work 'screenshot-test.png'
    Remove-Item $screenshotPng -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $screenshotLog = Join-Path $work 'screenshot.log'
    Remove-Item $screenshotLog -ErrorAction SilentlyContinue
    $sp = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$screenshotLog",
        '--mdv-timeout=30000', "--mdv-screenshot=$screenshotPng", $screenshotDoc) -PassThru -Wait -WindowStyle Hidden
    $screenshotText = Get-Content -Path $screenshotLog -Raw
    Check ($sp.ExitCode -eq 0) 'screenshot: a screenshot-only invocation (no --mdv-exit-after) still exits cleanly, not via the watchdog' "exitCode=$($sp.ExitCode)"
    Check ($screenshotText -match 'screenshot: saved') 'screenshot: the capture itself genuinely succeeds' $screenshotText
    Check ($screenshotText -notmatch 'WATCHDOG') 'screenshot: the watchdog never has to fire (this was a real hang before the fix)' $screenshotText
    $screenshotExists = Test-Path $screenshotPng
    $screenshotSize = $screenshotExists ? (Get-Item $screenshotPng).Length : 0
    $screenshotOk = $screenshotExists -and $screenshotSize -gt 1000
    Check $screenshotOk 'screenshot: a real, non-trivial PNG file is actually written to disk' "exists=$screenshotExists size=$screenshotSize"
    Check ($screenshotText -notmatch '\[js:error\]') 'screenshot: no uncaught JS errors'
    Remove-Item $screenshotPng -ErrorAction SilentlyContinue

    Write-Host ''

}

Add-Scenario 'plain-text' {
    # --- 28. a non-Markdown text file renders as literal plain text, not parsed
    # README's documented claim: "Non-Markdown text files render as plain text."
    # g_docPlain (main.cpp) is set for any non-.md extension and sent to JS,
    # which renders it through a literal <pre> instead of the markdown pipeline
    # (app.js's doc.plain branch) -- but this had never been tested anywhere:
    # does a .txt file containing markdown-LOOKING syntax actually stay
    # literal, or does it silently get parsed as markdown anyway? Deliberately
    # uses syntax that would produce an unambiguous, easily-observed
    # difference if broken (a real heading, a real link) -- reusing the
    # existing domSummary log rather than adding new instrumentation.
    $plainDoc = Join-Path $work 'plain-test.txt'
    Set-Content -Path $plainDoc -Value "# This looks like a heading`n`n**bold** text and a [link](http://example.com)`n" -NoNewline
    $r = Run $plainDoc @() 'plain-text'
    Check ($r.ExitCode -eq 0) 'plain-text: clean exit'
    Check ($r.Log -match 'domSummary.*headings=0') 'plain-text: markdown-looking syntax in a .txt file is NOT parsed -- zero real headings, not one' $r.Log
    Check ($r.Log -match 'domSummary.*links=0') 'plain-text: a markdown-looking link is not parsed into a real <a>, either' $r.Log
    CheckNoJsErrors $r 'plain-text'

    Write-Host ''

}

Add-Scenario 'watcher-threadproc' {
    # --- 29. Watcher::ThreadProc's two early-return paths no longer corrupt
    # Watcher::Stop()'s bookkeeping (a real use-after-free/use-after-close, fixed
    # in this pass). ThreadProc used to free its Session and return directly --
    # without going through Stop() -- whenever FindFirstChangeNotificationW
    # failed (directory deleted/unmounted/ACL-denied before the watch thread
    # even starts) or FindNextChangeNotification failed mid-loop (the same,
    # happening after the watch is already running). Either one left
    # Watcher::thread_ and the old Session* populated; the NEXT Stop() call
    # (always reached eventually -- at minimum when the process exits) then did
    # SetEvent() through a pointer into freed heap, via an already-closed handle.
    # --mdv-watch-fail=first|next forces each path deterministically via a real
    # (if synthetic) Win32 API failure -- a nonexistent watch directory for
    # "first", a null handle passed to FindNextChangeNotification for "next" --
    # rather than chasing the real-world race (the directory happening to
    # disappear at exactly the wrong moment). Both modes log an explicit marker
    # the instant the fault-injected failure is hit, so this checks the fault
    # path was GENUINELY exercised, not just that the process happened to exit
    # cleanly for an unrelated reason.
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $watchFailFirstDoc = Join-Path $work 'watch-fail-first.md'
    Set-Content -Path $watchFailFirstDoc -Value "# Watch-fail first`n`nBody.`n" -NoNewline
    $rFirst = Run $watchFailFirstDoc @('--mdv-watch-fail=first') 'watch-fail-first'
    Check ($rFirst.Log -match 'watch-fail-test: FindFirstChangeNotificationW failed as expected \(first\)') 'watch-fail(first): the fault-injected FindFirstChangeNotificationW failure was genuinely hit' $rFirst.Log
    Check ($rFirst.ExitCode -eq 0) 'watch-fail(first): clean exit after Stop() runs against a thread that already self-exited (no use-after-free)' "exit=$($rFirst.ExitCode)"
    Check (-not ($rFirst.Log -match 'WATCHDOG:')) 'watch-fail(first): the watchdog never has to fire' $rFirst.Log
    CheckNoJsErrors $rFirst 'watch-fail-first'

    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $watchFailNextDoc = Join-Path $work 'watch-fail-next.md'
    Set-Content -Path $watchFailNextDoc -Value "# Watch-fail next`n`nBody.`n" -NoNewline
    $watchFailNextLog = Join-Path $work 'watch-fail-next.log'
    Remove-Item $watchFailNextLog -ErrorAction SilentlyContinue
    $wfnp = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$watchFailNextLog",
        '--mdv-timeout=60000', '--mdv-exit-after=4000', '--mdv-watch-fail=next', $watchFailNextDoc) -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(55)
    $sawFirstRenderWatchFail = $false
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $watchFailNextLog) -and ((Get-Content $watchFailNextLog -Raw) -match 'renderComplete')) {
            $sawFirstRenderWatchFail = $true; break
        }
        Start-Sleep -Milliseconds 200
    }
    if ($sawFirstRenderWatchFail) {
        Start-Sleep -Milliseconds 300   # let the exit-after timer arm settle before racing it
        Set-Content -Path $watchFailNextDoc -Value "# Watch-fail next`n`nModified body, to trigger a real change notification.`n" -NoNewline
    }
    $wfnp.WaitForExit()
    $watchFailNextLogText = if (Test-Path $watchFailNextLog) { Get-Content $watchFailNextLog -Raw } else { '' }

    Check $sawFirstRenderWatchFail 'watch-fail(next): first render completes before the file is modified'
    Check ($watchFailNextLogText -match 'watch-fail-test: FindNextChangeNotification failed as expected \(next\)') 'watch-fail(next): the fault-injected FindNextChangeNotification failure was genuinely hit, from a real file-change notification' $watchFailNextLogText
    Check ($wfnp.ExitCode -eq 0) 'watch-fail(next): clean exit after Stop() runs against a thread that already self-exited (no use-after-free)' "exit=$($wfnp.ExitCode)"
    Check (-not ($watchFailNextLogText -match 'WATCHDOG:')) 'watch-fail(next): the watchdog never has to fire' $watchFailNextLogText
    CheckNoJsErrors ([PSCustomObject]@{ Log = $watchFailNextLogText }) 'watch-fail-next'

    Write-Host ''

}

Add-Scenario 'profile-dir' {
    # --- 30. --mdv-profile-dir gives each launch a genuinely separate WebView2
    # user-data folder, instead of the one shared %TEMP%\MDView.debug.wv2 every
    # scenario in this suite otherwise wipes before every launch. That shared
    # mutability is exactly what has made running scenarios in parallel unsafe:
    # two concurrent instances would delete and recreate the SAME directory out
    # from under each other. This flag exists so a future parallel scenario
    # runner has somewhere safe to point each worker.
    $customProfileDir = Join-Path $work 'custom-profile-dir'
    Remove-Item -Recurse -Force $customProfileDir -ErrorAction SilentlyContinue
    $defaultProfileDir = "$env:TEMP\MDView.debug.wv2"
    $defaultMtimeBefore = (Get-Item $defaultProfileDir -ErrorAction SilentlyContinue).LastWriteTimeUtc
    $profileDirDoc = Join-Path $work 'profile-dir-test.md'
    Set-Content -Path $profileDirDoc -Value "# Profile dir test`n`nBody.`n" -NoNewline
    $profileDirLog = Join-Path $work 'profile-dir-test.log'
    Remove-Item $profileDirLog -ErrorAction SilentlyContinue
    $pdArgs = @('--mdv-headless', "--mdv-log=$profileDirLog", '--mdv-timeout=60000', '--mdv-exit-after=1500',
        "--mdv-profile-dir=$customProfileDir", $profileDirDoc)
    $pdp = Start-Process -FilePath $exe -ArgumentList $pdArgs -PassThru -Wait -WindowStyle Hidden
    $profileDirLogText = if (Test-Path $profileDirLog) { Get-Content $profileDirLog -Raw } else { '' }
    $defaultMtimeAfter = (Get-Item $defaultProfileDir -ErrorAction SilentlyContinue).LastWriteTimeUtc

    Check ($pdp.ExitCode -eq 0) 'profile-dir: clean exit using a custom --mdv-profile-dir'
    Check (Test-Path (Join-Path $customProfileDir 'EBWebView')) 'profile-dir: the custom directory is genuinely the one WebView2 populated, not just created empty'
    Check ($defaultMtimeBefore -eq $defaultMtimeAfter) 'profile-dir: the DEFAULT shared profile directory is genuinely untouched (real isolation, not just a differently-named copy of the same behavior)' "before=$defaultMtimeBefore after=$defaultMtimeAfter"
    CheckNoJsErrors ([PSCustomObject]@{ Log = $profileDirLogText }) 'profile-dir'
    Remove-Item -Recurse -Force $customProfileDir -ErrorAction SilentlyContinue

    Write-Host ''

}

Add-Scenario 'profile-relaunch' {
    # --- 31. relaunching over a genuinely populated WebView2 profile ------------
    # Every OTHER scenario in this suite deletes the shared profile directory
    # before launching (Run() does this on line 35), so no scenario before this
    # one has ever exercised SweepTempProfile()'s real-world case: a relaunch
    # finding a directory a PRIOR instance actually populated, the thing every
    # real user hits every time they reopen the app. Uses its own dedicated
    # --mdv-profile-dir (not the shared default) so this scenario is isolated
    # from every other one. This closes the investigation recorded in
    # docs/BACKLOG.md ("the startup measurement") -- the cause of the
    # multi-second timing swings observed there turned out to be inconclusive
    # (system load, not profile handling), but the untested relaunch-over-a-
    # populated-profile PATH itself is worth covering regardless of what
    # explains its timing.
    $b2bProfileDir = Join-Path $work 'back-to-back-profile'
    Remove-Item -Recurse -Force $b2bProfileDir -ErrorAction SilentlyContinue
    $b2bDoc = Join-Path $work 'back-to-back-doc.md'
    Set-Content -Path $b2bDoc -Value "# Back-to-back launch test`n`nBody.`n" -NoNewline

    $b2bLog1 = Join-Path $work 'back-to-back-1.log'
    Remove-Item $b2bLog1 -ErrorAction SilentlyContinue
    $b2bArgs1 = @('--mdv-headless', "--mdv-log=$b2bLog1", '--mdv-timeout=60000', '--mdv-exit-after=1500',
        "--mdv-profile-dir=$b2bProfileDir", $b2bDoc)
    $b2bp1 = Start-Process -FilePath $exe -ArgumentList $b2bArgs1 -PassThru -Wait -WindowStyle Hidden
    $b2bLog1Text = if (Test-Path $b2bLog1) { Get-Content $b2bLog1 -Raw } else { '' }
    Check ($b2bp1.ExitCode -eq 0) 'back-to-back: first launch (cold, empty profile) exits cleanly'
    Check ($b2bLog1Text -match 'profile sweep: existed=0') 'back-to-back: first launch genuinely finds no prior profile' $b2bLog1Text

    # Deliberately no wipe here -- this is the whole point of the scenario.
    $b2bLog2 = Join-Path $work 'back-to-back-2.log'
    Remove-Item $b2bLog2 -ErrorAction SilentlyContinue
    $b2bArgs2 = @('--mdv-headless', "--mdv-log=$b2bLog2", '--mdv-timeout=60000', '--mdv-exit-after=1500',
        "--mdv-profile-dir=$b2bProfileDir", $b2bDoc)
    $b2bp2 = Start-Process -FilePath $exe -ArgumentList $b2bArgs2 -PassThru -Wait -WindowStyle Hidden
    $b2bLog2Text = if (Test-Path $b2bLog2) { Get-Content $b2bLog2 -Raw } else { '' }
    Check ($b2bp2.ExitCode -eq 0) 'back-to-back: second launch (over a genuinely populated profile) exits cleanly'
    Check ($b2bLog2Text -match 'profile sweep: existed=1') 'back-to-back: second launch genuinely finds the first launch''s real profile before sweeping it' $b2bLog2Text
    Check ($b2bLog2Text -match 'domSummary.*headings=1') 'back-to-back: the document still renders correctly on the second launch' $b2bLog2Text
    Check (-not ($b2bLog2Text -match 'WATCHDOG:')) 'back-to-back: the watchdog never has to fire on the second launch'
    CheckNoJsErrors ([PSCustomObject]@{ Log = $b2bLog2Text }) 'back-to-back (second launch)'
    Remove-Item -Recurse -Force $b2bProfileDir -ErrorAction SilentlyContinue

    Write-Host ''

}

Add-Scenario 'reload-defer' {
    # --- 32. TryAutoReload() defers rather than drops a reload while a real ------
    # IFileDialog::Show() is up (main.cpp's g_modalDepth/ModalScope). Show() pumps
    # its own message loop while blocking its caller, so a file-watcher change
    # notification can arrive and run WM_APP_WATCH -> TIMER_RELOAD while the
    # native Open/Save dialog is genuinely still on screen; before this fix
    # TryAutoReload() would proceed anyway, replacing g_docUtf8 (and firing
    # ReloadDoc()'s title/render path) out from under a dialog the user is still
    # looking at. --mdv-modal-test (debug-only) simulates a real dialog being
    # open for a fixed window without needing an actual modal call: it increments
    # g_modalDepth inside WM_APP_WATCH itself (landing deterministically, not on
    # real-world timing luck) and decrements it 500ms later. The discriminating
    # signal is ORDER, not just eventual success: the second render must land
    # strictly AFTER the "decremented" log line, proving the reload was genuinely
    # deferred and not just coincidentally slow. Verified against the literal
    # pre-fix behavior (temporarily disabling the g_modalDepth check): the second
    # render then lands BEFORE "decremented", the exact bug this guards against.
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $modalDoc = Join-Path $work 'modal-test-doc.md'
    Set-Content -Path $modalDoc -Value "# Modal test`n`nBody text.`n" -NoNewline
    $modalLog = Join-Path $work 'modal-test.log'
    Remove-Item $modalLog -ErrorAction SilentlyContinue
    $mtp = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$modalLog",
        '--mdv-timeout=60000', '--mdv-exit-after=4000', '--mdv-modal-test', $modalDoc) -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(55)
    $sawFirstRenderModal = $false
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $modalLog) -and ((Get-Content $modalLog -Raw) -match 'renderComplete')) {
            $sawFirstRenderModal = $true; break
        }
        Start-Sleep -Milliseconds 200
    }
    if ($sawFirstRenderModal) {
        Start-Sleep -Milliseconds 300   # let the exit-after timer arm settle before racing it
        Add-Content -Path $modalDoc -Value "`n## External marker (applied only after the simulated dialog closes)"
    }
    $mtp.WaitForExit()
    $modalLogText = if (Test-Path $modalLog) { Get-Content $modalLog -Raw } else { '' }

    function Get-ElapsedMs([string]$text, [string]$linePattern) {
        $m = [regex]::Match($text, "\+\s*([\d.]+)ms\][^\n]*$linePattern")
        if (-not $m.Success) { return $null }
        return [double]$m.Groups[1].Value
    }
    $modalIncMs = Get-ElapsedMs $modalLogText 'modal-test: g_modalDepth incremented'
    $modalDecMs = Get-ElapsedMs $modalLogText 'modal-test: g_modalDepth decremented'
    $renderMatches = [regex]::Matches($modalLogText, '\+\s*([\d.]+)ms\][^\n]*\[js:renderComplete\]')
    $secondRenderMs = if ($renderMatches.Count -ge 2) { [double]$renderMatches[1].Groups[1].Value } else { $null }

    Check $sawFirstRenderModal 'modal-test: first render completes before the external change'
    Check ($null -ne $modalIncMs) 'modal-test: the simulated dialog-open injection was genuinely hit' $modalLogText
    Check ($null -ne $modalDecMs) 'modal-test: the simulated dialog-close injection was genuinely hit' $modalLogText
    Check ($renderMatches.Count -eq 2) 'modal-test: the deferred reload eventually renders exactly once more (not dropped, not double-fired)' $modalLogText
    Check (($null -ne $secondRenderMs) -and ($null -ne $modalDecMs) -and ($secondRenderMs -gt $modalDecMs)) 'modal-test: the second render lands AFTER the simulated dialog closes, proving TryAutoReload() genuinely deferred it rather than proceeding while the dialog was still open' $modalLogText
    Check ($modalLogText -match 'domSummary.*headings=2') 'modal-test: the deferred reload actually picked up the external change once it ran' $modalLogText
    Check ($mtp.ExitCode -eq 0) 'modal-test: clean exit' "exit=$($mtp.ExitCode)"
    CheckNoJsErrors ([PSCustomObject]@{ Log = $modalLogText }) 'modal-test'

}

Add-Scenario 'doc-token-guard' {
    # --- 33. g_docToken guard on https://doc.local/__self__ --------------------
    # fetchAndRenderFile() (app.js) fetches __self__ separately from the 'doc'
    # message that triggers it, so nothing previously tied the two together --
    # an in-flight request from an OLDER 'doc' message, resolving AFTER a NEWER
    # one had already replaced g_docUtf8, could return the newer document's
    # bytes paired with the older message's path/dir/name (main.cpp's
    # HandleWebResource __self__ branch, app.js's fetchAndRenderFile). Rather
    # than chase the real out-of-order-network-resolution timing (inherently
    # flaky to force on demand, and the fix itself is a pure state comparison
    # with no timing dependency once you have it -- see g_docToken's comment),
    # --mdv-self-token-test proves the actual guard directly: two REAL fetches
    # through the real __self__ handler right after the first file open, one
    # with a deliberately stale ?tok=, one with the current one.
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $tokDoc = Join-Path $work 'self-token-test-doc.md'
    Set-Content -Path $tokDoc -Value "# Self token test`n`nBody text.`n" -NoNewline
    $tr = Run $tokDoc @('--mdv-self-token-test') 'self-token-test'
    Check ($tr.ExitCode -eq 0) 'self-token-test: clean exit'
    Check ($tr.Log -match '\[js:selfTokenTestComplete\] n=2 failures=0') 'self-token-test: both the stale-token 409 and the current-token 200 checks pass against the REAL __self__ handler, not a reimplementation of it' $tr.Log
    CheckNoJsErrors $tr 'self-token-test'

}

Add-Scenario 'log-rotate' {
    # --- 34. AppendLog's log-file rotation ---------------------------------------
    # Nothing capped or rotated MDView-crash.log before this -- a long-lived
    # install's log grows forever across its entire lifetime. RotateLogIfNeeded()
    # (main.cpp) is checked once, when AppendLog (re)opens its handle: past 2MB,
    # the existing file becomes <path>.old (at most one prior generation kept)
    # and a fresh one starts. Seed a real >2MB file at a dedicated --mdv-log path
    # BEFORE launching -- no debug flag needed, this is a pure function of the
    # log file's size at open time, so real filesystem state exercises the real
    # code path directly.
    $rotateLog = Join-Path $work 'rotate-test.log'
    $rotateOld = "$rotateLog.old"
    Remove-Item $rotateLog, $rotateOld -ErrorAction SilentlyContinue
    $rotateLine = ('x' * 1000) + "`n"
    $sw = [System.IO.StreamWriter]::new($rotateLog, $false)
    for ($i = 0; $i -lt 2200; $i++) { $sw.Write($rotateLine) }
    $sw.Close()
    $seededSize = (Get-Item $rotateLog).Length
    $rotateDoc = Join-Path $work 'rotate-test-doc.md'
    Set-Content -Path $rotateDoc -Value "# Rotate test`n`nBody.`n" -NoNewline
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $rotp = Start-Process -FilePath $exe -ArgumentList @('--mdv-headless', "--mdv-log=$rotateLog",
        '--mdv-timeout=60000', '--mdv-exit-after=800', $rotateDoc) -PassThru -Wait -WindowStyle Hidden
    Check ($rotp.ExitCode -eq 0) 'log-rotate: clean exit'
    Check ($seededSize -gt 2mb) 'log-rotate: the seeded file genuinely exceeds the 2MB rotation threshold' "seeded=$seededSize"
    Check (Test-Path $rotateOld) 'log-rotate: the oversized file was rotated to .old, not silently kept growing' "old exists=$(Test-Path $rotateOld)"
    if (Test-Path $rotateOld) {
        Check ((Get-Item $rotateOld).Length -eq $seededSize) 'log-rotate: .old is the FULL prior generation, byte-for-byte, not truncated' "old=$((Get-Item $rotateOld).Length) seeded=$seededSize"
    }
    $rotateNewText = if (Test-Path $rotateLog) { Get-Content $rotateLog -Raw } else { '' }
    Check ((Test-Path $rotateLog) -and (Get-Item $rotateLog).Length -lt 100kb) 'log-rotate: the new file starts fresh, not appended onto the rotated one' "new size=$((Get-Item $rotateLog -ErrorAction SilentlyContinue).Length)"
    Check ($rotateNewText -match 'instance: solo') 'log-rotate: the new file still has real, correctly-formatted routine log lines (rotation only changes WHEN a new file starts, never the line format)' $rotateNewText
    CheckNoJsErrors ([PSCustomObject]@{ Log = $rotateNewText }) 'log-rotate'
    Remove-Item $rotateLog, $rotateOld -ErrorAction SilentlyContinue

}

Add-Scenario 'export-test' {
    # --- 35. Export as HTML actually writes a real file -------------------------
    # ExportHtml()'s own IFileSaveDialog::Show() can't be driven headlessly (no
    # one to click it) -- --mdv-export-test proves the write side directly
    # (WriteHtmlExport(), factored out of the dialog flow specifically so this
    # doesn't need one), the same split SaveDocumentTo/SaveDocumentAs already
    # has for the exact same reason.
    $exportDoc = Join-Path $work 'export-test-doc.md'
    Set-Content -Path $exportDoc -Value "# Export test`n`nBody.`n" -NoNewline
    $exportTarget = "$exportDoc.export-test.html"
    Remove-Item $exportTarget -ErrorAction SilentlyContinue
    $er = Run $exportDoc @('--mdv-export-test') 'export-test'
    Check ($er.ExitCode -eq 0) 'export-test: clean exit'
    Check ($er.Log -match 'export-test: WriteHtmlExport\(\) called directly') 'export-test: WriteHtmlExport() was genuinely called' $er.Log
    Check (Test-Path $exportTarget) 'export-test: a real HTML file was actually written to disk' "target=$exportTarget"
    if (Test-Path $exportTarget) {
        Check ((Get-Content $exportTarget -Raw) -match '<!doctype html>') 'export-test: the written file is real HTML, not empty or garbage'
    }
    CheckNoJsErrors $er 'export-test'
    Remove-Item $exportTarget -ErrorAction SilentlyContinue

}

Add-Scenario 'pdf-test' {
    # --- 36. Export as PDF actually writes a real file ---------------------------
    # Same reasoning as export-test: ExportPdf()'s own IFileSaveDialog::Show()
    # can't be driven headlessly, so --mdv-pdf-test calls WritePdfExport()
    # directly. Unlike WriteHtmlExport, PrintToPdf() (ICoreWebView2_7) is
    # genuinely async -- its completion handler fires later, on the same message
    # loop, so this needs a longer --mdv-exit-after than the 800ms default (Run's
    # own hardcoded value) gives every other scenario, or the process could close
    # before PrintToPdf ever finishes. Passed as a second, later occurrence of the
    # same flag -- main.cpp's arg parser just overwrites g_debugExitAfterMs each
    # time it sees one, so whichever comes last in argv wins.
    $pdfDoc = Join-Path $work 'pdf-test-doc.md'
    Set-Content -Path $pdfDoc -Value "# PDF test`n`nBody.`n" -NoNewline
    $pdfTarget = "$pdfDoc.pdf-test.pdf"
    Remove-Item $pdfTarget -ErrorAction SilentlyContinue
    $pr = Run $pdfDoc @('--mdv-pdf-test', '--mdv-exit-after=5000') 'pdf-test'
    Check ($pr.ExitCode -eq 0) 'pdf-test: clean exit'
    Check ($pr.Log -match 'pdf-test: WritePdfExport\(\) called directly') 'pdf-test: WritePdfExport() was genuinely called' $pr.Log
    Check ($pr.Log -match 'PrintToPdf completed: errorCode=0x0 result=1') 'pdf-test: PrintToPdf''s async completion handler actually fired, reporting success' $pr.Log
    Check (Test-Path $pdfTarget) 'pdf-test: a real PDF file was actually written to disk' "target=$pdfTarget"
    if (Test-Path $pdfTarget) {
        $pdfBytes = [IO.File]::ReadAllBytes($pdfTarget)
        $pdfHeader = [Text.Encoding]::ASCII.GetString($pdfBytes, 0, [Math]::Min(5, $pdfBytes.Length))
        Check ($pdfHeader -eq '%PDF-') 'pdf-test: the written file is a real PDF, not empty or garbage' "header=$pdfHeader bytes=$($pdfBytes.Length)"
    }
    CheckNoJsErrors $pr 'pdf-test'
    Remove-Item $pdfTarget -ErrorAction SilentlyContinue

    Write-Host ''

}

Add-Scenario 'session-restore' {
    # --- 37. session restore reopens the last document on a doc-less launch -----
    # JS-side (assets/app.js), not native: on 'ready' it decides whether to post
    # an 'openPath' for S.recent[0], based on window.__MDV_BOOT's solo/hasDoc
    # flags plus the (opaque-to-native) settings blob's own restoreLastDoc/recent
    # fields. No CLI document argument is passed to Run() at all here -- BOOT.hasDoc
    # would otherwise be true, which is exactly the "an explicit file always wins"
    # case this scenario must NOT trigger. Like chrome-test/pdf-test, needs its
    # own scratch exe copy (a pre-seeded settings ADS) rather than the shared
    # Run() helper, which always appends a positional doc argument.
    $restoreExe = Join-Path $work 'restore-test.exe'
    Copy-Item -Path $exe -Destination $restoreExe -Force
    $restoreDoc = Join-Path $work 'restore-doc.md'
    Set-Content -Path $restoreDoc -Value "# Restore test`n`nBody.`n" -NoNewline
    $restoreDocFull = (Resolve-Path $restoreDoc).Path

    Get-Process 'restore-test' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $restoreSettingsOn = @{ restoreLastDoc = $true; recent = @(@{ path = $restoreDocFull; name = 'restore-doc.md' }) } | ConvertTo-Json -Compress -Depth 5
    Set-Content -Path $restoreExe -Stream 'mdv.settings' -Value $restoreSettingsOn -NoNewline
    $restoreOnLog = Join-Path $work 'restore-on.log'
    Remove-Item $restoreOnLog -ErrorAction SilentlyContinue
    Start-Process -FilePath $restoreExe -ArgumentList @('--mdv-headless', "--mdv-log=$restoreOnLog",
        '--mdv-timeout=60000', '--mdv-exit-after=3000') -Wait -WindowStyle Hidden
    $restoreOnText = if (Test-Path $restoreOnLog) { Get-Content $restoreOnLog -Raw } else { '' }
    Check ($restoreOnText -match [regex]::Escape("opened: $restoreDocFull nav=new")) 'session-restore: the JS restore decision reopened the right file' $restoreOnText
    Check ($restoreOnText -match [regex]::Escape("webview ready, handing off doc=$restoreDocFull")) 'session-restore: the openPath/ready reordering means native already knows the doc by the time it handles ready -- no Welcome-screen flash' $restoreOnText
    Check ($restoreOnText -match '\[js:renderComplete\]') 'session-restore: the restored document actually rendered' $restoreOnText
    Check ($restoreOnText -match 'headings=1') 'session-restore: domSummary reflects the restored document''s real content' $restoreOnText
    CheckNoJsErrors ([PSCustomObject]@{ Log = $restoreOnText }) 'session-restore (on)'

    # Negative case: restoreLastDoc absent (same as the reader's own default)
    # must NOT reopen anything, proving the earlier PASS isn't just always-on
    # behavior with the settings blob incidental.
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    $restoreSettingsOff = @{ recent = @(@{ path = $restoreDocFull; name = 'restore-doc.md' }) } | ConvertTo-Json -Compress -Depth 5
    Set-Content -Path $restoreExe -Stream 'mdv.settings' -Value $restoreSettingsOff -NoNewline
    $restoreOffLog = Join-Path $work 'restore-off.log'
    Remove-Item $restoreOffLog -ErrorAction SilentlyContinue
    Start-Process -FilePath $restoreExe -ArgumentList @('--mdv-headless', "--mdv-log=$restoreOffLog",
        '--mdv-timeout=60000', '--mdv-exit-after=3000') -Wait -WindowStyle Hidden
    $restoreOffText = if (Test-Path $restoreOffLog) { Get-Content $restoreOffLog -Raw } else { '' }
    Check ($restoreOffText -notmatch 'opened:') 'session-restore: restoreLastDoc:false (the default) never reopens anything' $restoreOffText
    Check ($restoreOffText -match 'webview ready, handing off doc=\(none\)') 'session-restore: with restore off, the welcome screen is genuinely what shows' $restoreOffText
    CheckNoJsErrors ([PSCustomObject]@{ Log = $restoreOffText }) 'session-restore (off)'

    Write-Host ''
}


# ---------------------------------------------------------------- CLI driver
# Runs the scenarios registered above via Add-Scenario, honoring -List/-Only/
# -Skip/-ResultsJson. Default (no params) runs every scenario in registration
# order -- identical to this script's old unconditional top-to-bottom
# behavior. Deliberately NOT parallel (see docs/BACKLOG.md): that needs its
# own per-scenario work-dir isolation first, since every scenario here still
# shares one $work directory and would race another scenario's files if run
# concurrently.
if ($List) {
    $scenarios.Keys | ForEach-Object { Write-Host $_ }
    exit 0
}

$toRun = [System.Collections.Generic.List[string]]::new()
if ($Only) {
    foreach ($name in $Only) {
        if ($scenarios.Contains($name)) { $toRun.Add($name) }
        else { Write-Host "FAIL  unknown scenario passed to -Only: $name" -ForegroundColor Red; $script:failures++ }
    }
} elseif ($Skip) {
    foreach ($name in $Skip) {
        if (-not $scenarios.Contains($name)) { Write-Host "FAIL  unknown scenario passed to -Skip: $name" -ForegroundColor Red; $script:failures++ }
    }
    foreach ($name in $scenarios.Keys) {
        if ($Skip -notcontains $name) { $toRun.Add($name) }
    }
} else {
    foreach ($name in $scenarios.Keys) { $toRun.Add($name) }
}

$scenarioResults = [System.Collections.Generic.List[object]]::new()
foreach ($name in $toRun) {
    $script:scenarioChecks = 0
    $failuresBefore = $script:failures
    # A distinctively-named timer, not a generic $sw: scenarios are dot-sourced
    # (". $scenarios[$name]", not "&"), deliberately sharing this exact scope
    # so cross-scenario visibility like $travTargetDir keeps working -- which
    # also means a scenario reusing a short/generic variable name here (the
    # log-rotate scenario already has its own $sw, a StreamWriter) would
    # silently clobber this one and crash the very next line.
    $mdvScenarioTimerStart = Get-Date
    . $scenarios[$name]
    $checks = $script:scenarioChecks
    $failed = $script:failures - $failuresBefore
    if ($checks -eq 0) {
        Write-Host "FAIL  $name`: scenario produced zero checks -- likely a silent no-op or an early return that skipped its own Check() calls" -ForegroundColor Red
        $script:failures++
        $failed++
    }
    $scenarioResults.Add([PSCustomObject]@{
        name = $name; checks = $checks; failed = $failed
        ms = [math]::Round(((Get-Date) - $mdvScenarioTimerStart).TotalMilliseconds, 1)
    })
}

if ($ResultsJson) {
    $scenarioResults | ConvertTo-Json -Depth 3 | Set-Content -Path $ResultsJson -NoNewline
    Write-Host "Wrote scenario results to $ResultsJson"
}


# $work accumulates several full scratch copies of the exe (corrupt-ads,
# case-dedup, unicode-filename, chrome-test -- ~5MB each) plus every scratch
# document/log/image this run created; $travTargetDir is its sibling
# traversal-check target directory. Neither is ever cleaned mid-run (several
# scenarios re-read their own scratch exe's ADS streams later in the same
# run), so this is the only safe place to do it. Only on a clean pass --
# a failing run leaves its scratch artifacts in place for post-mortem
# inspection instead of deleting the evidence. ($travTargetDir is assigned by
# scenario 10's setup -- stays $null, guarded below, when -Only/-Skip left
# that scenario out of this particular run: Remove-Item -Path $null is a
# terminating parameter-binding error, not something -ErrorAction
# SilentlyContinue on the same call suppresses.)
if ($failures -eq 0) {
    Write-Host "All checks passed." -ForegroundColor Green
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    if ($travTargetDir) { Remove-Item -Recurse -Force $travTargetDir -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
    exit 0
} else {
    Write-Host "$failures check(s) failed." -ForegroundColor Red
    Write-Host "Scratch files left under $work$(if ($travTargetDir) { " and $travTargetDir" }) for inspection." -ForegroundColor Yellow
    exit 1
}
