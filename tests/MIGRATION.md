# Assertion migration ledger

Complete. `debugRunEditorTest()` (the giant in-page test function predating this project's real
test harness) has been fully migrated: every assertion reachable through the Playwright harness
now lives in `tests/specs/*.spec.mjs`, and every pure renderer-logic check with zero DOM
dependency lives in `tests/node/render-node.test.mjs`. The function itself was renamed
`debugRunNativeTest()` to match what's left in it — see its own doc comment in `assets/app.js`.

What stays there, permanently, because it needs the real native exe and can't move to the
Playwright harness:

- `openExternal`'s and the `__abs__`/`openPath` resource-loader guard's defense-in-depth
  (main.cpp's own independent scheme/UNC checks — only reachable via a real
  postMessage → native → postMessage round trip).
- `saveClipboardImage`'s real-file-write round trip (FakeNative's simulation never writes an
  actual file unless a `pastedImageWriter` callback is supplied, which the shared Playwright
  fixture doesn't supply). Its malformed-base64 rejection path *did* migrate, to
  `tests/specs/save-clipboard-image-malformed.spec.mjs` — that's a pure rejection-path check
  FakeNative already faithfully simulates.

Detail on how each section was migrated (approach chosen, new hooks added, discriminating-power
verification) lives in the commit history, not here — see `git log` / `CHANGELOG.md`.
