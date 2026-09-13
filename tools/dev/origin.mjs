// A faithful port of HandleWebResource() (src/main.cpp:1179-1239), including
// the IsSafeLocalPath()/IsLocalDrivePath() confinement guards (src/main.cpp:
// 603-621), so this dev origin is never more permissive than production.
// Used by both the Playwright test harness and the `npm run dev` server --
// one implementation, zero drift between what a test proves and what a
// human sees while iterating.
//
// This module is pure request -> response logic (no http/https-specific
// code, no Playwright-specific code), so it's directly unit-testable and
// reusable by both consumers.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const APP_ORIGIN = 'https://app.local/';
const DOC_ORIGIN = 'https://doc.local/';

const TEXT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

// Mirrors MimeForExt (src/main.cpp:581-593) exactly -- the whitelist of
// document-relative local media types __abs__ is allowed to serve.
const MEDIA_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

// Mirrors IsLocalDrivePath (src/main.cpp:603-605): true only for a genuine
// drive-absolute Windows path ("C:\..."), false for UNC (\\server\share),
// device paths (\\?\, \\.\), or anything else. `full` must already be
// canonicalized (via path.resolve, the Node analogue of GetFullPathNameW)
// before this check means anything.
function isLocalDrivePath(full) {
  return full.length >= 3 && full[0] !== '\\' && full[1] === ':';
}

// Mirrors IsSafeLocalPath (src/main.cpp:613-621): confines `full` to the
// `dir` subtree, case-insensitively, on a path-separator boundary (so
// "C:\docs2" is never treated as inside "C:\docs").
function isSafeLocalPath(full, dir) {
  if (!isLocalDrivePath(full)) return false;
  if (!dir) return false;
  let d = dir;
  while (d.length && (d.endsWith('\\') || d.endsWith('/'))) d = d.slice(0, -1);
  const lf = full.toLowerCase();
  const ld = d.toLowerCase();
  if (lf.length < ld.length || lf.slice(0, ld.length) !== ld) return false;
  return lf.length === ld.length || lf[ld.length] === '\\';
}

function stripQueryAndFragment(uri) {
  const i = uri.search(/[?#]/);
  return i === -1 ? uri : uri.slice(0, i);
}

// Mirrors QueryParamULL (src/main.cpp) -- extracts a "key=value" query
// parameter's raw string value from a full request URI, or null if absent.
function queryParam(uri, key) {
  const m = uri.match(new RegExp(`[?&]${key}=([^&#]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * @param {string} rawUri  Full request URI, e.g. "https://app.local/app.js?v=1"
 *   or a bare path ("/app.js") -- both accepted, matching how a Node http
 *   server's req.url (path-only) and a full URI (as WebView2 hands
 *   HandleWebResource) both need to work through the same logic.
 * @param {object} opts
 * @param {string} opts.assetsDir  Absolute path to the real assets/ directory
 *   on disk -- the SAME bytes src/app.rc embeds, not a copy.
 * @param {() => {docUtf8: string, docDir: string, docToken?: number|string}} opts.getDocState
 *   Returns the CURRENT document text/dir/token at request time (a function,
 *   not a snapshot, so a reload mid-test is reflected immediately -- mirrors
 *   main.cpp's g_docUtf8/g_docDir/g_docToken being read live by
 *   HandleWebResource). docToken defaults to 0 when omitted, matching
 *   FakeNative's initial state -- __self__ still enforces the match (see
 *   below), it just means "no document has ever loaded yet".
 * @returns {Promise<{status:number, headers:Record<string,string>, body:Buffer|null}>}
 */
export async function handleRequest(rawUri, { assetsDir, getDocState }) {
  const ACAO = { 'Access-Control-Allow-Origin': 'https://app.local' };
  const bare = stripQueryAndFragment(rawUri);

  if (bare.startsWith(APP_ORIGIN) || bare.startsWith('/')) {
    let reqPath = bare.startsWith(APP_ORIGIN) ? bare.slice(APP_ORIGIN.length) : bare.slice(1);
    if (reqPath === '') reqPath = 'index.html';
    // Confine to assetsDir -- reject any ../ escape before ever touching disk.
    const filePath = path.join(assetsDir, reqPath);
    if (!filePath.startsWith(assetsDir)) {
      return { status: 404, headers: ACAO, body: null };
    }
    try {
      const data = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const cache = reqPath.startsWith('vendor/') || reqPath.startsWith('vendor\\');
      return {
        status: 200,
        headers: {
          ...ACAO,
          'Content-Type': TEXT_MIME[ext] || 'application/octet-stream',
          'Cache-Control': cache ? 'max-age=3600' : 'no-cache',
        },
        body: data,
      };
    } catch {
      return { status: 404, headers: ACAO, body: null };
    }
  }

  if (bare.startsWith(DOC_ORIGIN)) {
    const reqPath = bare.slice(DOC_ORIGIN.length);
    const { docUtf8, docDir, docToken = 0 } = getDocState();

    if (reqPath === '__self__') {
      // Mirrors HandleWebResource's __self__ branch: decline (409) a request
      // built from a 'doc' message a newer one has since superseded, rather
      // than serving whatever docUtf8 currently holds paired with stale
      // path/dir/name metadata. See g_docToken's comment in main.cpp.
      if (queryParam(rawUri, 'tok') !== String(docToken)) {
        return { status: 409, headers: ACAO, body: null };
      }
      return {
        status: 200,
        headers: { ...ACAO, 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' },
        body: Buffer.from(docUtf8 ?? '', 'utf-8'),
      };
    }

    if (reqPath.startsWith('__abs__/')) {
      const decoded = decodeURIComponent(reqPath.slice('__abs__/'.length)).replace(/\//g, '\\');
      const full = path.resolve(docDir || process.cwd(), decoded);
      if (isSafeLocalPath(full, docDir)) {
        const ext = path.extname(full).toLowerCase();
        const mime = MEDIA_MIME[ext];
        if (mime) {
          try {
            const st = await stat(full);
            if (st.isFile()) {
              const data = await readFile(full);
              return { status: 200, headers: { ...ACAO, 'Content-Type': mime, 'Cache-Control': 'max-age=3600' }, body: data };
            }
          } catch { /* fall through to 404 */ }
        }
      }
      return { status: 404, headers: ACAO, body: null };
    }

    return { status: 403, headers: ACAO, body: null };
  }

  return { status: 404, headers: ACAO, body: null };
}

export const _internal = { isLocalDrivePath, isSafeLocalPath, stripQueryAndFragment };
