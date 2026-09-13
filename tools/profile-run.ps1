# Drives MDView.debug.exe headlessly and prints one row per run.
#
# Every measurement in this project's performance work goes through here
# rather than through ad-hoc one-off commands: single samples on a busy
# desktop have repeatedly proven misleading, so the default is N repeats
# with the median reported, and each run's full JSON profile is kept for
# comparison.
#
#   .\tools\profile-run.ps1 -Docs mixed,code -Repeat 7
#   .\tools\profile-run.ps1 -Docs mixed -ExtraArgs '--mdv-frame-budget=16'
param(
    [string[]]$Docs = @('mixed'),
    [int]$Repeat = 7,
    [int]$Runs = 1,                 # separate process launches per document
    [string[]]$ExtraArgs = @(),
    [string]$CorpusDir,             # defaults to out\corpus, auto-generated if missing
    [string]$Label = 'run',
    [switch]$KeepProfile           # don't wipe the WebView2 profile between launches
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root 'out\MDView.debug.exe'
$outDir = Join-Path $root 'out\prof'
New-Item -ItemType Directory -Force $outDir | Out-Null

if (-not $CorpusDir) { $CorpusDir = Join-Path $root 'out\corpus' }
if (-not (Test-Path (Join-Path $CorpusDir 'manifest.json'))) {
    Write-Host "Corpus manifest missing under $CorpusDir -- generating it (tools\corpus\gen-corpus.mjs)..."
    & node (Join-Path $root 'tools\corpus\gen-corpus.mjs')
    if ($LASTEXITCODE -ne 0) { throw "gen-corpus.mjs failed" }
}

foreach ($doc in $Docs) {
    $docPath = Join-Path $CorpusDir "$doc.md"
    if (-not (Test-Path $docPath)) { Write-Host "MISSING $docPath"; continue }

    for ($r = 1; $r -le $Runs; $r++) {
        if (-not $KeepProfile) {
            Remove-Item -Recurse -Force "$env:TEMP\MDView.debug.wv2" -ErrorAction SilentlyContinue
        }
        $tag = "$Label-$doc-$r"
        $log = Join-Path $outDir "$tag.log"
        $json = Join-Path $outDir "$tag.json"
        Remove-Item $log, $json -ErrorAction SilentlyContinue

        $exeArgs = @(
            '--mdv-headless', "--mdv-log=$log", "--mdv-profile=$json",
            "--mdv-repeat=$Repeat", '--mdv-timeout=60000', '--mdv-exit-after=1500'
        ) + $ExtraArgs + @($docPath)

        $p = Start-Process -FilePath $exe -ArgumentList $exeArgs -PassThru -Wait -WindowStyle Hidden
        if (-not (Test-Path $json)) {
            Write-Host ("{0,-22} EXIT={1} (no profile written)" -f $tag, $p.ExitCode)
            continue
        }
        $j = Get-Content $json -Raw | ConvertFrom-Json
        $ph = @{}
        foreach ($e in $j.phases) { $ph[$e.name] = $e.atMs }
        $navToReady = if ($ph.ContainsKey('page-ready') -and $ph.ContainsKey('navigating')) {
            [math]::Round($ph['page-ready'] - $ph['navigating'], 0) } else { 'n/a' }
        $median = if ($j.renderStats -match 'median=([\d.]+)') { $matches[1] } else { 'n/a' }
        $min = if ($j.renderStats -match 'min=([\d.]+)') { $matches[1] } else { 'n/a' }

        Write-Host ("{0,-22} outcome={1,-17} ready={2,6}ms navToReady={3,6}ms renderMin={4,7}ms renderMed={5,7}ms peakWS={6}MB" -f `
            $tag, $j.outcome,
            [math]::Round($ph['page-ready'], 0), $navToReady, $min, $median,
            [math]::Round($j.peakWorkingSetKB / 1024, 0))
        if ($j.renderStats -match '\|(.*)$') { Write-Host ("  phases:{0}" -f $matches[1]) }
    }
}
