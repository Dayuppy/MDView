@{
    # Bug-finding rules only -- same philosophy as eslint.config.js (see its
    # own header comment): no Prettier-equivalent formatting enforcement,
    # and no rule aimed at style/API-surface conventions these scripts were
    # never trying to follow in the first place (they're one-shot local
    # tools invoked directly, not shared modules or cmdlets meant for
    # someone else's pipeline).
    ExcludeRules = @(
        # regression.ps1 has two deliberate `try { ... } catch {}` blocks
        # (case-dedup, unicode-filename) where a parse failure is exactly
        # what's under test: the catch leaves a bool flag at its already-
        # false default, and the very next Check() call reports that as
        # the failure. Same reasoning as eslint.config.js's own
        # `no-empty: { allowEmptyCatch: true }` for the identical pattern
        # in assets/app.js -- a blanket allowance there too, since
        # PSScriptAnalyzer's suppression attribute needs a function/
        # scriptblock target and doesn't fit suppressing one top-level
        # statement the way an ESLint disable-next-line comment does.
        'PSAvoidUsingEmptyCatchBlock',

        # Every script here is a CLI tool printing status straight to a
        # human at a terminal -- exactly what Write-Host is for. The rule's
        # own objection (doesn't work when there's no host, can't be
        # captured/redirected) doesn't apply: nothing pipes these scripts'
        # output onward or runs them hostless.
        'PSAvoidUsingWriteHost',

        # A missing BOM only matters for non-ASCII content on older
        # Windows PowerShell hosts; this project's scripts are ASCII (with
        # the odd em/en dash, already tested working without one for as
        # long as this repo has existed).
        'PSUseBOMForUnicodeEncodedFile',

        # make-icon.ps1's New-IconPng is a one-shot local build helper, not
        # a shared cmdlet meant to support -WhatIf/-Confirm.
        'PSUseShouldProcessForStateChangingFunctions',

        # regression.ps1's Get-ElapsedMs returns a single number ("Ms" is
        # part of the unit, not a plural noun) -- renaming it means
        # updating every call site for a purely cosmetic naming nitpick.
        'PSUseSingularNouns'
    )
}
