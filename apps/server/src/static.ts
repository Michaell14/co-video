/**
 * Static hosting for the two front-end builds, so a small deployment needs nothing but this server:
 *
 *   /        the marketing site   (siteDist)
 *   /app/    the editor, an SPA   (editorDist) — unknown paths below it fall back to index.html
 *
 * Both are optional; a mount exists only if its directory does when the server starts.
 */
import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { HttpError, assertMethod, sendEmpty, sendThrown, streamFile } from './http';
import { errorCode } from './util';

const EDITOR_PREFIX = '/app';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function cacheControl(relativePath: string, extension: string): string {
  // The entry documents must be revalidated, or a deploy would not reach returning visitors.
  if (extension === '.html') return 'no-cache';
  // Same for the service worker and the web-app manifest: both describe "the current build".
  if (relativePath.endsWith('/sw.js') || extension === '.webmanifest') return 'no-cache';
  // Vite puts content-hashed files into assets/: a new build means new names, so cache for good.
  if (relativePath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

interface OpenFile {
  handle: FileHandle;
  size: number;
  mtimeMs: number;
}

/** Open `path` if it is a regular file. `null` for anything else (missing, a directory, …). */
async function openFile(path: string): Promise<OpenFile | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ENAMETOOLONG') return null;
    throw err;
  }
  try {
    const info = await handle.stat();
    if (info.isFile()) return { handle, size: info.size, mtimeMs: info.mtimeMs };
  } catch (err) {
    await handle.close();
    throw err;
  }
  await handle.close();
  return null;
}

/**
 * Headers for the HTML documents we serve. The pages load nothing from other origins, so the policy
 * can say so: even if markup were ever injected, it could not pull in a script, post a form
 * elsewhere, or be framed by another site.
 */
export function documentSecurityHeaders(req: IncomingMessage): Record<string, string> {
  // Older engines do not let 'self' cover WebSockets, so name our own host explicitly.
  const host =
    typeof req.headers.host === 'string' && /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(req.headers.host)
      ? req.headers.host
      : null;
  const sockets = host ? ` ws://${host} wss://${host}` : '';
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      // WebAssembly is allowed for codec fallbacks; inline and remote scripts are not.
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' data: blob:${sockets}`,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)',
  };
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: OpenFile,
  status: number,
  contentType: string,
  cache: string,
): Promise<void> {
  const etag = `W/"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': cache,
    ETag: etag,
    'Last-Modified': new Date(file.mtimeMs).toUTCString(),
    ...(contentType.startsWith('text/html') ? documentSecurityHeaders(req) : null),
  };
  if (status === 200 && req.headers['if-none-match'] === etag) {
    await file.handle.close();
    sendEmpty(res, 304, headers);
    return;
  }
  res.writeHead(status, { ...headers, 'Content-Length': file.size });
  if (req.method === 'HEAD' || file.size === 0) {
    await file.handle.close();
    res.end();
    return;
  }
  await streamFile(res, file.handle); // closes the handle
}

/**
 * Returns a request handler for everything that is not `/api` or `/ws`, or `null` if neither
 * build directory exists.
 */
export function createStaticHandler(dirs: { siteDist: string; editorDist: string }) {
  const siteRoot = isDirectory(dirs.siteDist) ? resolve(dirs.siteDist) : null;
  const editorRoot = isDirectory(dirs.editorDist) ? resolve(dirs.editorDist) : null;
  if (!siteRoot && !editorRoot) return null;

  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    search: string,
  ): Promise<void> {
    assertMethod(req, ['GET', 'HEAD']);
    let path: string;
    try {
      path = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'malformed URL');
    }
    if (!path.startsWith('/') || path.includes('\0')) throw new HttpError(400, 'malformed URL');

    let root = siteRoot;
    let spa = false;
    if (editorRoot && (path === EDITOR_PREFIX || path.startsWith(`${EDITOR_PREFIX}/`))) {
      if (path === EDITOR_PREFIX) {
        // Relative URLs in the editor's index.html only resolve correctly below /app/.
        sendEmpty(res, 308, { Location: `${EDITOR_PREFIX}/${search}` });
        return;
      }
      root = editorRoot;
      spa = true;
      path = path.slice(EDITOR_PREFIX.length);
    }
    if (!root) throw new HttpError(404, 'not found');

    // Path traversal guard: resolve the request against the root, then insist that the result is
    // still inside it. Dotfiles (.env, .git, …) are never served, whatever ends up in a build;
    // .well-known is the one dot-directory that exists to be public.
    const target = resolve(root, `.${path}`);
    const inside = target === root || target.startsWith(root + sep);
    const hidden = path.split('/').some((segment) => segment.startsWith('.') && segment !== '.well-known');
    if (!inside || hidden) throw new HttpError(404, 'not found');

    const candidates = path.endsWith('/')
      ? [resolve(target, 'index.html')]
      : [target, `${target}.html`, resolve(target, 'index.html')];
    for (const candidate of candidates) {
      const file = await openFile(candidate);
      if (!file) continue;
      const extension = extname(candidate).toLowerCase();
      const relative = candidate.slice(root.length).split(sep).join('/');
      const type = MIME_TYPES[extension] ?? 'application/octet-stream';
      await sendFile(req, res, file, 200, type, cacheControl(relative, extension));
      return;
    }

    // SPA fallback: client-side routes get the app shell. Requests that are clearly for a file
    // (they have an extension) get an honest 404 instead of HTML with the wrong content type.
    const fallback = spa && extname(path) === '' ? 'index.html' : spa ? null : '404.html';
    const file = fallback ? await openFile(resolve(root, fallback)) : null;
    if (!file) throw new HttpError(404, 'not found');
    await sendFile(req, res, file, spa ? 200 : 404, MIME_TYPES['.html'], 'no-cache');
  }

  /** Never rejects. */
  return async function handleStatic(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    search: string,
  ): Promise<void> {
    try {
      await serve(req, res, pathname, search);
    } catch (err) {
      sendThrown(res, err);
    }
  };
}
