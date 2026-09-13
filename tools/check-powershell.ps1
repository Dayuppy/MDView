# PSScriptAnalyzer over this project's own PowerShell scripts (docs/BACKLOG.md's
# tooling-foundation item) -- bug-finding rules only, same philosophy as
# eslint.config.js. See PSScriptAnalyzerSettings.psd1 (repo root) for the
# excluded rules and why each one doesn't apply here.
#
#   .\tools\check-powershell.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$settings = Join-Path $root 'PSScriptAnalyzerSettings.psd1'

if (-not (Get-Module -ListAvailable PSScriptAnalyzer)) {
    Write-Host 'PSScriptAnalyzer is not installed -- run: Install-Module PSScriptAnalyzer -Scope CurrentUser'
    exit 1
}

$scripts = @('build.ps1', 'tools\make-icon.ps1', 'tools\profile-run.ps1', 'tools\regression.ps1')
$findings = @()
foreach ($script in $scripts) {
    $findings += Invoke-ScriptAnalyzer -Path (Join-Path $root $script) -Settings $settings -Severity Warning, Error
}

if ($findings.Count -eq 0) {
    Write-Host 'check-powershell: clean'
    exit 0
}

$findings | Format-Table -AutoSize
Write-Host "check-powershell: $($findings.Count) finding(s)"
exit 1
