// One-off spike (BACKLOG.md "Next -- tooling foundation"): does a dedicated
// Worker's importScripts() of the 22 vendored files actually work when
// served from a local Node HTTPS origin under Playwright/Chromium, the way
// it will need to for the fast front-end test harness (tools/dev/origin.mjs
// + Playwright, per the approved plan)? Everything in that plan assumes yes.
// If this fails, the harness design changes materially (falls back to
// page.route() for the worker's subresources, with reduced fidelity).
//
// Deliberately uses the REAL assets/worker.js unmodified -- no simulation --
// posting a real markdown string and checking for a real {ok:true, chunks}
// response, exactly the production message contract (assets/worker.js:79-93).
//
//   node tools/dev/spike-worker-import.mjs

import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const assetsDir = path.join(root, 'assets');
const PORT = 8443;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

function generateCert() {
  const attrs = [{ name: 'commonName', value: 'app.local' }];
  // selfsigned@5's generate() is async (backed by @peculiar/x509 + WebCrypto).
  return selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'app.local' },
          { type: 2, value: 'doc.local' },
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
}

// Minimal wrapper page: same origin as worker.js/vendor/*, so importScripts'
// relative paths resolve exactly as they do for the real app served from
// https://app.local by main.cpp's HandleWebResource().
const SPIKE_HTML = `<!doctype html><meta charset="utf-8"><title>spike</title>
<script>
window.__spikeResult = new Promise((resolve) => {
  try {
    const w = new Worker('/worker.js');
    const timer = setTimeout(() => resolve({ ok: false, error: 'timeout waiting for worker response' }), 10000);
    w.onerror = (e) => { clearTimeout(timer); resolve({ ok: false, error: 'worker onerror: ' + e.message }); };
    w.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    w.postMessage({ text: '# Spike\\n\\nSome **bold** text and a [link](https://example.com).\\n' });
  } catch (err) {
    resolve({ ok: false, error: 'sync throw constructing Worker: ' + String(err) });
  }
});
</script>`;

async function handler(req, res) {
  try {
    if (req.url === '/' || req.url === '/spike.html') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(SPIKE_HTML);
      return;
    }
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const filePath = path.join(assetsDir, rel);
    if (!filePath.startsWith(assetsDir) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end('not found: ' + rel);
      return;
    }
    const ext = path.extname(filePath);
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
}

async function main() {
  const pems = await generateCert();
  const server = createServer({ key: pems.private, cert: pems.cert }, handler);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`[spike] https server listening on 127.0.0.1:${PORT}`);

  const browser = await chromium.launch({
    args: [
      `--host-resolver-rules=MAP app.local:443 127.0.0.1:${PORT}`,
      '--ignore-certificate-errors',
    ],
  });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    page.on('console', (msg) => console.log('[page console]', msg.type(), msg.text()));
    page.on('pageerror', (err) => console.log('[page error]', err));

    console.log('[spike] navigating to https://app.local/spike.html ...');
    await page.goto('https://app.local/spike.html', { waitUntil: 'load' });

    console.log('[spike] awaiting worker response (real importScripts of 22 vendor files + md-setup.js) ...');
    const result = await page.evaluate(() => window.__spikeResult);

    console.log('[spike] result:', JSON.stringify(result, null, 2).slice(0, 2000));

    if (result.ok && Array.isArray(result.chunks) && result.chunks.length > 0) {
      const html = result.chunks.join('');
      const looksRight = /<h1[^>]*>Spike<\/h1>/.test(html) && /<strong>bold<\/strong>/.test(html) &&
        /<a[^>]*href="https:\/\/example\.com"/.test(html);
      console.log(`[spike] chunk HTML sanity check: ${looksRight ? 'PASS' : 'FAIL'}`);
      console.log('[spike] first chunk:', html.slice(0, 300));
      console.log(looksRight ? '\n=== SPIKE PASSED: worker importScripts() over local HTTPS origin works ===' : '\n=== SPIKE FAILED: worker responded but content is wrong ===');
      process.exitCode = looksRight ? 0 : 1;
    } else {
      console.log('\n=== SPIKE FAILED: worker did not produce a valid {ok:true, chunks} response ===');
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('[spike] fatal:', err);
  process.exitCode = 1;
});
