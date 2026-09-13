// tools/dev/origin.mjs is a port of HandleWebResource() -- the confinement
// guards (isSafeLocalPath/isLocalDrivePath) are the security-critical part,
// so they get tested directly before anything else is built on top of this
// module. Pure Node, no browser: `node --test tests/node/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleRequest, _internal } from '../../tools/dev/origin.mjs';

const { isLocalDrivePath, isSafeLocalPath } = _internal;

test('isLocalDrivePath: drive-absolute paths only', () => {
  assert.equal(isLocalDrivePath('C:\\Users\\x\\doc.md'), true);
  assert.equal(isLocalDrivePath('c:\\x'), true);
  assert.equal(isLocalDrivePath('\\\\server\\share\\x'), false, 'UNC path must be rejected');
  assert.equal(isLocalDrivePath('\\\\?\\C:\\x'), false, 'device path must be rejected');
  assert.equal(isLocalDrivePath('relative\\path'), false);
});

test('isSafeLocalPath: confines to the directory subtree, case-insensitively, on a boundary', () => {
  const dir = 'C:\\Users\\x\\Documents';
  assert.equal(isSafeLocalPath('C:\\Users\\x\\Documents\\image.png', dir), true);
  assert.equal(isSafeLocalPath('C:\\USERS\\X\\DOCUMENTS\\image.png', dir), true, 'case-insensitive');
  assert.equal(isSafeLocalPath('C:\\Users\\x\\Documents', dir), true, 'the directory itself');
  // The classic prefix-boundary bug: "...Documents2" must NOT match "...Documents".
  assert.equal(isSafeLocalPath('C:\\Users\\x\\Documents2\\image.png', dir), false);
  assert.equal(isSafeLocalPath('C:\\Users\\x\\image.png', dir), false, 'outside the subtree');
  assert.equal(isSafeLocalPath('\\\\attacker\\share\\x.png', dir), false, 'UNC must never pass, even inside a matching-looking string');
  assert.equal(isSafeLocalPath('C:\\Users\\x\\Documents\\image.png', ''), false, 'empty dir is never safe');
});

async function withFixture(fn) {
  const base = await mkdtemp(path.join(tmpdir(), 'mdv-origin-test-'));
  const assetsDir = path.join(base, 'assets');
  const docDir = path.join(base, 'docs');
  const outsideDir = path.join(base, 'outside');
  await mkdir(assetsDir, { recursive: true });
  await mkdir(path.join(assetsDir, 'vendor'), { recursive: true });
  await mkdir(docDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(assetsDir, 'index.html'), '<html>hi</html>');
  await writeFile(path.join(assetsDir, 'app.js'), 'console.log(1);');
  await writeFile(path.join(assetsDir, 'vendor', 'lib.js'), '// vendor');
  await writeFile(path.join(docDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(outsideDir, 'secret.png'), Buffer.from([1, 2, 3]));
  try {
    await fn({ assetsDir, docDir, outsideDir });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function docState(docDir, text = '# doc\n', docToken = 0) {
  return () => ({ docUtf8: text, docDir, docToken });
}

test('app.local: serves a known file with the right content-type and no-cache', async () => {
  await withFixture(async ({ assetsDir, docDir }) => {
    const r = await handleRequest('https://app.local/app.js', { assetsDir, getDocState: docState(docDir) });
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/javascript; charset=utf-8');
    assert.equal(r.headers['Cache-Control'], 'no-cache');
    assert.equal(r.body.toString('utf-8'), 'console.log(1);');
  });
});

test('app.local: empty path defaults to index.html', async () => {
  await withFixture(async ({ assetsDir, docDir }) => {
    const r = await handleRequest('https://app.local/', { assetsDir, getDocState: docState(docDir) });
    assert.equal(r.status, 200);
    assert.match(r.body.toString('utf-8'), /hi/);
  });
});

test('app.local: vendor/ paths are cached, others are not', async () => {
  await withFixture(async ({ assetsDir, docDir }) => {
    const r = await handleRequest('https://app.local/vendor/lib.js', { assetsDir, getDocState: docState(docDir) });
    assert.equal(r.headers['Cache-Control'], 'max-age=3600');
  });
});

test('app.local: missing file is 404, path traversal is 404 not a directory escape', async () => {
  await withFixture(async ({ assetsDir, docDir }) => {
    const miss = await handleRequest('https://app.local/nope.js', { assetsDir, getDocState: docState(docDir) });
    assert.equal(miss.status, 404);
    const traversal = await handleRequest('https://app.local/../../../../windows/win.ini', { assetsDir, getDocState: docState(docDir) });
    assert.equal(traversal.status, 404);
  });
});

test('doc.local/__self__: serves the current in-memory document text when the token matches', async () => {
  await withFixture(async ({ assetsDir, docDir }) => {
    const r = await handleRequest('https://doc.local/__self__?tok=0', { assetsDir, getDocState: docState(docDir, '# Hello\n') });
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/markdown; charset=utf-8');
    assert.equal(r.body.toString('utf-8'), '# Hello\n');
  });
});

// Mirrors main.cpp's g_docToken guard: a request built from a 'doc' message
// a newer one has since superseded must be declined, not served the newer
// document's bytes under the older message's identity.
test('doc.local/__self__: 409s a stale token instead of serving the current document under it', async () => {
  await withFixture(async ({ assetsDir, docDir }) => {
    const stale = await handleRequest('https://doc.local/__self__?tok=0', { assetsDir, getDocState: docState(docDir, '# New doc\n', 1) });
    assert.equal(stale.status, 409);
    assert.equal(stale.body, null);
    const missing = await handleRequest('https://doc.local/__self__', { assetsDir, getDocState: docState(docDir, '# New doc\n', 1) });
    assert.equal(missing.status, 409, 'a request with no ?tok= at all must never be treated as a match');
    const fresh = await handleRequest('https://doc.local/__self__?tok=1', { assetsDir, getDocState: docState(docDir, '# New doc\n', 1) });
    assert.equal(fresh.status, 200);
  });
});

test('doc.local/__abs__: serves an in-bounds media file', async () => {
  await withFixture(async ({ assetsDir, docDir }) => {
    const target = path.join(docDir, 'image.png');
    const r = await handleRequest('https://doc.local/__abs__/' + encodeURIComponent(target), {
      assetsDir, getDocState: docState(docDir),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'image/png');
    assert.equal(r.headers['Cache-Control'], 'max-age=3600');
  });
});

test('doc.local/__abs__: rejects a path outside the document directory (traversal)', async () => {
  await withFixture(async ({ assetsDir, docDir, outsideDir }) => {
    const target = path.join(outsideDir, 'secret.png');
    const r = await handleRequest('https://doc.local/__abs__/' + encodeURIComponent(target), {
      assetsDir, getDocState: docState(docDir),
    });
    assert.equal(r.status, 404, 'must not leak a file outside docDir, and must not distinguish "exists but forbidden" from "not found"');
  });
});

test('doc.local/__abs__: rejects a UNC path outright (no SMB/NTLM probe)', async () => {
  await withFixture(async ({ assetsDir, docDir }) => {
    const r = await handleRequest('https://doc.local/__abs__/' + encodeURIComponent('\\\\attacker-host\\share\\x.png'), {
      assetsDir, getDocState: docState(docDir),
    });
    assert.equal(r.status, 404);
  });
});

test('doc.local/__abs__: rejects a non-whitelisted extension even if in-bounds', async () => {
  await withFixture(async ({ assetsDir, docDir }) => {
    const target = path.join(docDir, 'notmedia.exe');
    await writeFile(target, 'x');
    const r = await handleRequest('https://doc.local/__abs__/' + encodeURIComponent(target), {
      assetsDir, getDocState: docState(docDir),
    });
    assert.equal(r.status, 404);
  });
});

test('doc.local: any other path is 403 Forbidden', async () => {
  await withFixture(async ({ assetsDir, docDir }) => {
    const r = await handleRequest('https://doc.local/something-else', { assetsDir, getDocState: docState(docDir) });
    assert.equal(r.status, 403);
  });
});
