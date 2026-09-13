// Migrated out of debugRunEditorTest() (tests/MIGRATION.md) -- PURIFY_CFG's
// ALLOWED_URI_REGEXP carves out one narrow exception to DOMPurify's default
// scheme allowlist (see the comment on PURIFY_CFG itself, assets/app.js
// ~line 1041): a bare drive letter like "C:" must NOT read as an
// unrecognized scheme (the same bucket "javascript:" falls into), because
// the drag-drop-image-from-outside-doc-folder fallback in main.cpp
// (WM_DROPFILES) posts an absolute Windows path as the image src. Three
// checks: an absolute path with a space keeps its src, a relative path with
// a space keeps its src (never had a scheme prefix to begin with, so this
// guards against the carve-out accidentally being too broad), and a
// hand-written javascript: src is still stripped (the carve-out must stay
// narrow -- raw HTML in markdown bypasses markdown-it's own link
// validation, so this is the only backstop against it).
//
// Calls DOMPurify.sanitize(md.render(...), PURIFY_CFG) directly rather than
// opening a real document and inspecting #content's img[src]: decorate()
// (called after DOMPurify in the real render pipeline) immediately rewrites
// any surviving img[src] into a doc.local URL via windowsPathFrom()/
// toDocUrl() -- a real end-to-end open would conflate that separate
// rewriting concern with the URI-scheme allowlist this section is actually
// about, and would need to decode the rewritten URL back to the original
// path to say anything at all about DOMPurify's own behavior. `md` and
// `PURIFY_CFG` are already exposed on __MDV_TEST for exactly this kind of
// check; `DOMPurify` itself is a real global here too (assets/index.html
// loads vendor/purify.min.js as a plain <script>, the same global app.js
// itself addresses bare as `DOMPurify`), so no new hook is needed.

import { test, expect } from '../harness/fixtures.mjs';

test('DOMPurify: an absolute Windows path with a space keeps its img src', async ({ mdv }) => {
  const html = await mdv.page.evaluate(() => {
    const { md, PURIFY_CFG } = window.__MDV_TEST;
    return window.DOMPurify.sanitize(md.render('![alt](<C:/Test Folder/image.png>)'), PURIFY_CFG);
  });
  expect(html).toMatch(/<img[^>]*\ssrc="C:\/Test%20Folder\/image\.png"/);
});

test('DOMPurify: a relative path with a space keeps its img src', async ({ mdv }) => {
  const html = await mdv.page.evaluate(() => {
    const { md, PURIFY_CFG } = window.__MDV_TEST;
    return window.DOMPurify.sanitize(md.render('![alt](<sub folder/image.png>)'), PURIFY_CFG);
  });
  expect(html).toMatch(/<img[^>]*\ssrc="sub%20folder\/image\.png"/);
});

test('DOMPurify: a javascript: src is still stripped', async ({ mdv }) => {
  const html = await mdv.page.evaluate(() => {
    const { PURIFY_CFG } = window.__MDV_TEST;
    return window.DOMPurify.sanitize('<img src="javascript:alert(1)">', PURIFY_CFG);
  });
  expect(html).not.toMatch(/\ssrc=/);
});
