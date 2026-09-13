# Builds out\MDView.exe — a single statically-linked executable.
# Requires: Visual Studio (any edition) with the C++ workload.
#
# -Debug builds out\MDView.debug.exe instead: the same app plus scripted
# headless-testing support (see README.md "Headless testing"), compiled in
# behind #ifdef MDV_DEBUG so none of it exists in the normal build.
#
# -Test builds and runs tools\test-textio.cpp (the save-path unit tests) —
# a separate mode, not a flag combined with a normal build.
#
# -Analyze adds MSVC's /analyze static analyzer to a -Debug build. Separate
# and non-default: it is slow and its false-positive rate makes it a poor
# gate for every ordinary build.
param(
    [switch]$Debug,
    [switch]$Test,
    [switch]$Analyze
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# locate MSVC via vswhere and enter the x64 dev environment
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw "Visual Studio with C++ tools not found." }
Import-Module (Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null

if ($Test) {
    New-Item -ItemType Directory -Force "$root\out" | Out-Null
    Push-Location "$root\out"
    try {
        cl.exe /nologo /std:c++17 /EHsc /utf-8 /W4 /permissive- /I "$root\src" `
            "$root\tools\test-textio.cpp" `
            /Fo:"test-textio.obj" /Fe:"test-textio.exe"
        if ($LASTEXITCODE -ne 0) { throw "test-textio.cpp build failed" }
        & ".\test-textio.exe"
        $testExit = $LASTEXITCODE
        Remove-Item "test-textio.obj" -ErrorAction SilentlyContinue
        if ($testExit -ne 0) { throw "test-textio FAILED (exit $testExit)" }
        Write-Host "TEST OK  test-textio.cpp (save path: message parsing, UTF-8 conversion, file writer)"
    }
    finally { Pop-Location }
    return
}

if (-not (Test-Path "$root\assets\app.ico")) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\tools\make-icon.ps1"
}

$exeName = if ($Debug) { 'MDView.debug' } else { 'MDView' }
$defines = if ($Debug) { '/DUNICODE', '/D_UNICODE', '/DMDV_DEBUG' } else { '/DUNICODE', '/D_UNICODE' }

New-Item -ItemType Directory -Force "$root\out" | Out-Null
Push-Location "$root\out"
try {
    # .res rebuild is guarded by a timestamp check against every input that
    # actually goes into it (the .rc script itself, the resource ids, the
    # manifest, and every embedded asset) — re-embedding 4.6 MB of vendor JS
    # on every single main.cpp-only edit was pure waste. A build after any
    # asset/manifest/rc change still regenerates it correctly.
    $resPath = "$exeName.res"
    $rcInputs = @("$root\src\app.rc", "$root\src\resource.h", "$root\src\app.manifest") +
        (Get-ChildItem "$root\assets" -Recurse -File | ForEach-Object FullName)
    $resStale = -not (Test-Path $resPath)
    if (-not $resStale) {
        $resTime = (Get-Item $resPath).LastWriteTimeUtc
        $newestInput = ($rcInputs | ForEach-Object { (Get-Item $_).LastWriteTimeUtc } | Measure-Object -Maximum).Maximum
        $resStale = $newestInput -gt $resTime
    }
    if ($resStale) {
        rc.exe /nologo /i "$root\src" /fo $resPath "$root\src\app.rc"
        if ($LASTEXITCODE -ne 0) { throw "rc.exe failed" }
    }

    $analyzeFlags = if ($Analyze) { @('/analyze:external-', '/analyze') } else { @() }

    # /Zi + link /DEBUG: produces a real .pdb, so CrashHandler()'s logged
    # addr=/base=/rva= (see main.cpp) is actually resolvable against a
    # symbol, not just a raw, ASLR-randomized, otherwise-useless pointer.
    # /OPT:REF /OPT:ICF: /DEBUG alone disables the /RELEASE-implied defaults
    # for these, so they're restated explicitly rather than silently losing
    # dead-code/COMDAT-folding elimination.
    # No /LTCG: there is exactly one translation unit and /GL is never
    # passed, so LTCG has nothing to do beyond charging real link time.
    # /permissive- /W4: verified clean, zero warnings, on both configurations
    # before this flag was ever enabled by default (not blind).
    # /guard:cf /Qspectre /sdl: hardening, near-free for an app whose entire
    # threat model is "opens untrusted documents from disk."
    cl.exe /nologo /std:c++17 /O2 /MT /EHsc /W4 /permissive- /utf-8 /Zi /guard:cf /Qspectre /sdl @analyzeFlags @defines `
        /I "$root\sdk\build\native\include" `
        "$root\src\main.cpp" $resPath `
        /Fo:"$exeName.obj" `
        /Fe:"$exeName.exe" `
        /link /SUBSYSTEM:WINDOWS /DEBUG /OPT:REF /OPT:ICF /guard:cf `
        "$root\sdk\build\native\x64\WebView2LoaderStatic.lib"
    if ($LASTEXITCODE -ne 0) { throw "cl.exe failed" }

    # vc140.pdb is cl.exe's own intermediate compile-time PDB (distinct from
    # $exeName.pdb, the linker's real output) -- not needed once linking is
    # done, same as the .obj.
    Remove-Item "$exeName.obj", 'vc140.pdb' -ErrorAction SilentlyContinue
    $exe = Get-Item "$exeName.exe"
    Write-Host ("BUILD OK  {0}  {1:n0} KB" -f $exe.FullName, ($exe.Length / 1KB))
}
finally { Pop-Location }
