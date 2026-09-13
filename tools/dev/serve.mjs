// npm run dev -- serves assets/ straight from disk (zero drift from the
// shipped app: the exact same tools/dev/{origin,fake-native}.mjs mirrors
// and tests/harness/boot.mjs bridge shim the whole Playwright suite already
// depends on and verifies), opens a real, visible Chromium window pointed
// at it, and reloads that window automatically whenever anything under
// assets/ changes on disk. No build, no exe, no test framework.
//
//   npm run dev                        # welcome screen, no document
//   npm run dev -- path\to\doc.md      # opens a real file from disk
//   npm run dev -- --attach            # also prints a CDP endpoint to
//                                      # attach an external DevTools/VS Code
//                                      # debugger to (Playwright's own
//                                      # control connection is separate and
//                                      # always present regardless)
//
// Live-reload deliberately isn't SSE/EventSource-based, unlike the original
// plan's wording: since this script already holds Playwright's own `page`
// handle, calling page.reload() directly from Node on a file-change event is
// simpler and more robust than adding a client-side shim that would need to
// be carefully kept out of anything resembling the real shipped app.

import { readFileSync, watch } from 'node:fs';
import { createServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { chromium } from 'playwright';
import { handleRequest } from './origin.mjs';
import { FakeNative } from './fake-native.mjs';
import { bootInitScript } from '../../tests/harness/boot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const assetsDir = path.join(root, 'assets');

const args = process.argv.slice(2);
const attach = args.includes('--attach');
const docArg = args.find((a) => !a.startsWith('--'));

const native = new FakeNative();
if (docArg) {
  const full = path.resolve(process.cwd(), docArg);
  const text = readFileSync(full, 'utf-8');
  const name = path.basename(full);
  native.loadDoc({ path: full, dir: path.dirname(full), name, text });
  console.log(`[dev] opened ${full}`);
} else {
  console.log('[dev] no document given -- showing the welcome screen (npm run dev -- path\\to\\doc.md to open one)');
}

const pems = await selfsigned.generate([{ name: 'commonName', value: 'app.local' }], {
  days: 3650, keySize: 2048, algorithm: 'sha256',
  extensions: [{
    name: 'subjectAltName',
    altNames: [
      { type: 2, value: 'app.local' }, { type: 2, value: 'doc.local' },
      { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' },
    ],
  }],
});

const server = createServer({ key: pems.private, cert: pems.cert }, async (req, res) => {
  // app.local/doc.local both terminate on this one socket (the browser's own
  // --host-resolver-rules maps both here) -- reconstruct the full URI from
  // the Host header so handleRequest's origin-prefix matching has something
  // real to match against (see tests/harness/fixtures.mjs's own identical
  // comment -- the same fix was needed there for the same reason).
  const hostname = (req.headers.host || 'app.local').split(':')[0];
  const rawUri = `https://${hostname}${req.url}`;
  const r = await handleRequest(rawUri, {
    assetsDir,
    getDocState: () => ({ docUtf8: native.state.docText, docDir: native.state.docDir, docToken: native.state.docToken }),
  });
  res.writeHead(r.status, r.headers);
  res.end(r.body ?? undefined);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// Smoke-testable without opening a real, visible browser window (this
// project's own standing rule against unattended on-screen actions) --
// tests/node/dev-serve.test.mjs sets this to verify the server/origin/
// fake-native wiring and the CLI document-loading logic directly.
if (process.env.MDV_DEV_SERVER_ONLY) {
  console.log(`[dev] MDV_DEV_SERVER_ONLY set -- server up on port ${port}, not launching a browser`);
  process.send?.({ port });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
} else {

const launchArgs = [
  `--host-resolver-rules=MAP app.local:443 127.0.0.1:${port},MAP doc.local:443 127.0.0.1:${port}`,
  '--ignore-certificate-errors',
];
if (attach) launchArgs.push('--remote-debugging-port=9222');
const browser = await chromium.launch({ headless: false, args: launchArgs });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

await page.exposeFunction('__mdvNativeHandle', (msg) => native.handle(msg));
await page.exposeFunction('__mdvOnDebugLog', (level, text) => console.log(`[page:${level}] ${text}`));
native.onOutbound = (msg) => { page.evaluate((m) => window.__mdvDeliver(m), msg).catch(() => {}); };
// testHooks stays on (window.__MDV_TEST is handy for interactive poking from
// DevTools) but debug is off -- this should look and behave like a real
// launch, not a test harness, in every other respect.
await page.addInitScript(bootInitScript({ testHooks: true, debug: false }));
await page.goto('https://app.local/index.html');

console.log(`[dev] serving ${assetsDir}`);
if (attach) console.log('[dev] CDP: http://localhost:9222/json -- attach an external DevTools/VS Code debugger there');
console.log('[dev] edit any file under assets/ and save -- this window reloads automatically. Ctrl+C to stop.');

let reloadPending = false;
watch(assetsDir, { recursive: true }, (_event, filename) => {
  if (reloadPending) return;   // fs.watch can fire multiple events per save; coalesce
  reloadPending = true;
  setTimeout(async () => {
    reloadPending = false;
    console.log(`[dev] changed: ${filename} -- reloading`);
    try { await page.reload(); } catch { /* window closed by the user -- exit below picks this up */ }
  }, 80);
});

browser.on('disconnected', () => { server.close(); process.exit(0); });

}
