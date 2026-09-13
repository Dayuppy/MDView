// Playwright fixtures wiring tools/dev/origin.mjs + tools/dev/fake-native.mjs
// + tests/harness/boot.mjs into one `mdv` fixture a spec file can use
// directly. See docs/BACKLOG.md's "tooling foundation" entry for the design.
//
// Scoping: one HTTPS server + one Chromium instance per Playwright worker
// (expensive to create, safe to share -- neither holds document state);
// a fresh FakeNative + Page per TEST (cheap, and test isolation matters:
// no state should leak between tests).

import { test as base } from '@playwright/test';
import { createServer } from 'node:https';
import selfsigned from 'selfsigned';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { handleRequest } from '../../tools/dev/origin.mjs';
import { FakeNative } from '../../tools/dev/fake-native.mjs';
import { bootInitScript } from './boot.mjs';
import { MdvPage } from './mdv-page.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, '..', '..', 'assets');

export const test = base.extend({
  // Option fixture: a spec overrides it with test.use({ mdvBoot: {...} })
  // (see session-restore.spec.mjs) to reach boot-time flags/settings the
  // shared `mdv` fixture below always defaults -- most specs never touch it.
  mdvBoot: [{}, { option: true }],

  // Same idea, for FakeNative.addDoc() entries that must exist BEFORE
  // page.goto() -- e.g. session-restore.spec.mjs's restore attempt fires its
  // openPath the instant the page loads, too early for a test body to call
  // addDoc() itself once `mdv` resolves.
  mdvPreloadDocs: [[], { option: true }],

  // ---- worker-scoped: created once, shared by every test in this worker ----

  mdvServer: [async ({}, use) => {
    // Port 0 -> the OS picks a free ephemeral port. A fixed
    // BASE_PORT + workerIndex scheme hit a real EADDRINUSE race: if a
    // worker is recycled (a crashed/retried worker gets a fresh process but
    // the SAME workerIndex), the old worker's server.close() is async and
    // isn't guaranteed to have released the port before the replacement
    // worker computes the identical port and tries to bind it.
    let currentNative = null;

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
      // app.local AND doc.local both terminate on this one socket (Chromium's
      // --host-resolver-rules maps both to 127.0.0.1:<port>), but req.url is
      // just the path -- Node's http server never includes scheme+host in it.
      // Reconstruct the full URI from the Host header (which a real browser
      // DOES send correctly, one per virtual-host) so handleRequest's
      // origin-prefix matching (app.local vs doc.local) actually has
      // something to match against. Missing this made every doc.local
      // request silently fall through to a 404 -- caught by the very first
      // spec that actually opened a document and read the rendered DOM.
      const hostname = (req.headers.host || 'app.local').split(':')[0];
      const rawUri = `https://${hostname}${req.url}`;
      const r = await handleRequest(rawUri, {
        assetsDir,
        getDocState: () => currentNative
          ? { docUtf8: currentNative.state.docText, docDir: currentNative.state.docDir, docToken: currentNative.state.docToken }
          : { docUtf8: '', docDir: '', docToken: 0 },
      });
      res.writeHead(r.status, r.headers);
      res.end(r.body ?? undefined);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    await use({ port, setCurrentNative: (n) => { currentNative = n; } });
    server.close();
  }, { scope: 'worker' }],

  mdvBrowser: [async ({ mdvServer }, use) => {
    const browser = await chromium.launch({
      args: [
        `--host-resolver-rules=MAP app.local:443 127.0.0.1:${mdvServer.port},MAP doc.local:443 127.0.0.1:${mdvServer.port}`,
        '--ignore-certificate-errors',
        '--enable-precise-memory-info',
      ],
    });
    await use(browser);
    await browser.close();
  }, { scope: 'worker' }],

  // ---- test-scoped: fresh per test ----

  mdv: async ({ mdvServer, mdvBrowser, mdvBoot, mdvPreloadDocs }, use) => {
    const native = new FakeNative();
    for (const d of mdvPreloadDocs) native.addDoc(d);
    mdvServer.setCurrentNative(native);

    const context = await mdvBrowser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    const mdvPage = new MdvPage(page, native);
    native.onOutbound = (msg) => {
      page.evaluate((m) => window.__mdvDeliver(m), msg).catch(() => {});
    };

    await page.exposeFunction('__mdvNativeHandle', (msg) => { native.handle(msg); });
    await page.exposeFunction('__mdvOnDebugLog', (level, text) => { mdvPage._onDebugLog(level, text); });
    await page.addInitScript(bootInitScript(mdvBoot));

    await page.goto('https://app.local/index.html');
    await page.waitForFunction(() => !!window.__MDV_TEST);

    await use(mdvPage);

    mdvServer.setCurrentNative(null);
    await context.close();
  },
});

export const expect = base.expect;
