// tools/dev/serve.mjs (npm run dev) -- verifies the server/origin/fake-native
// wiring and the CLI document-loading logic directly, via
// MDV_DEV_SERVER_ONLY=1 (skips the real, visible browser launch this
// project's own standing rule says must never run unattended). What this
// deliberately does NOT cover: the browser-launch path itself (headed
// Chromium, --host-resolver-rules, CDP attach) -- not headlessly testable
// by construction, same category as a real IFileSaveDialog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const serveScript = path.join(root, 'tools', 'dev', 'serve.mjs');

function startServer(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serveScript, ...args], {
      cwd: root,
      env: { ...process.env, MDV_DEV_SERVER_ONLY: '1' },
    });
    let out = '';
    const onData = (chunk) => {
      out += chunk.toString();
      const m = out.match(/server up on port (\d+)/);
      if (m) { child.stdout.off('data', onData); resolve({ child, port: Number(m[1]), out: () => out }); }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => { if (code !== 0 && code !== null) reject(new Error(`serve.mjs exited ${code}: ${out}`)); });
    setTimeout(() => reject(new Error(`serve.mjs never printed its port. Output so far: ${out}`)), 8000);
  });
}

function fetchOver(port, hostname, urlPath) {
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: urlPath, headers: { Host: hostname }, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('serves index.html and app.js straight from disk', async () => {
  const { child, port } = await startServer([]);
  try {
    const html = await fetchOver(port, 'app.local', '/index.html');
    assert.equal(html.status, 200);
    assert.match(html.body, /<!DOCTYPE html>/);

    const js = await fetchOver(port, 'app.local', '/app.js');
    assert.equal(js.status, 200);
    assert.match(js.body, /MD Viewer/);
  } finally {
    child.kill();
  }
});

test('a document passed on the command line is genuinely loaded and served via __self__', async () => {
  const docPath = path.join(root, 'assets', 'demo.md');
  const { child, port } = await startServer([docPath]);
  try {
    // loadDoc()'s own _openInternal() increments docToken from its initial
    // 0, so the one real load this test performs makes it 1 -- not a magic
    // number, the direct consequence of fake-native.mjs's own documented
    // g_docToken-mirroring behavior (see origin.mjs's __self__ comment).
    const self = await fetchOver(port, 'doc.local', '/__self__?tok=1');
    assert.equal(self.status, 200);
    assert.match(self.body, /Everything MD Viewer can render/);   // demo.md's real first heading
  } finally {
    child.kill();
  }
});

test('with no document argument, __self__ has nothing to serve (welcome screen, matching a real launch with no CLI path)', async () => {
  const { child, port } = await startServer([]);
  try {
    const self = await fetchOver(port, 'doc.local', '/__self__?tok=0');
    // No document loaded -> docUtf8 is '', which __self__ still serves (200,
    // empty body) rather than 404 -- an empty document is a valid state, not
    // a missing one; app.js's own doc/nodoc message is what actually decides
    // whether to show the welcome screen, not this endpoint.
    assert.equal(self.status, 200);
    assert.equal(self.body, '');
  } finally {
    child.kill();
  }
});
