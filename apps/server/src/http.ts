/** HTTP plumbing shared by the API, media and static handlers: errors, JSON in/out, CORS, URL parsing. */
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { isClientAbort } from './util';

/** JSON request bodies are tiny (`{ name }`, `{ role }`); anything bigger is a mistake or an attack. */
export const MAX_JSON_BYTES = 64 * 1024;
/** How long a client may take to deliver a JSON body before we drop it. */
const JSON_BODY_TIMEOUT_MS = 15_000;
/**
 * When we answer before the request body has been read (errors, "already complete"), Node drains
 * the remaining bytes so the keep-alive connection stays usable. That is fine for an upload chunk
 * but not for a multi-gigabyte body, so above this size we close the connection instead.
 */
const MAX_DRAIN_BYTES = 64 * 1024 * 1024;

/** An error that maps to a specific HTTP status. Anything else thrown by a handler becomes a 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Headers every response carries, API or static. */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/** CORS headers for every `/api` response, preflight included. */
export function applyCorsHeaders(res: ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,HEAD,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Range, Upload-Offset, Upload-Length',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Upload-Offset, Upload-Complete, Content-Range, Accept-Ranges, Content-Length, Content-Type',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  // The API is protected by tokens in the URL / Authorization header, never by cookies, so letting
  // other origins embed responses (e.g. <video src> from a cross-origin-isolated editor) is safe.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

/**
 * Split a request target into path and query without `new URL()`, which would silently
 * normalise `..` segments and treat `//host/…` as an authority.
 */
export function parseRequestUrl(raw: string | undefined): {
  pathname: string;
  /** The query string including its `?`, or `''`. */
  search: string;
  query: URLSearchParams;
} {
  const url = raw ?? '/';
  const q = url.indexOf('?');
  const search = q === -1 ? '' : url.slice(q);
  return { pathname: q === -1 ? url : url.slice(0, q), search, query: new URLSearchParams(search) };
}

/**
 * Address used for rate limiting. Behind a reverse proxy every request arrives from the proxy's
 * address, so with `trustProxy` we use the last `X-Forwarded-For` entry — the one appended by the
 * proxy itself. (Earlier entries are supplied by the client and can be forged.)
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header[header.length - 1] : header;
    const last = value?.split(',').pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Make sure an unread request body cannot wedge the connection once we have decided to respond.
 * Small bodies are drained (keep-alive survives); large or unbounded ones cost us the connection.
 */
function settleUnreadBody(req: IncomingMessage, res: ServerResponse): void {
  if (req.complete) return;
  // `complete` is still false inside a synchronous handler even when there is no body at all,
  // so look at the framing headers to tell "nothing to read" from "not read yet".
  const chunked = req.headers['transfer-encoding'] !== undefined;
  const declared = Number(req.headers['content-length'] ?? 0);
  if (!chunked && declared === 0) return;
  if ((chunked || !(declared <= MAX_DRAIN_BYTES)) && !res.headersSent) res.setHeader('Connection', 'close');
  req.resume();
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  settleUnreadBody(res.req, res);
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

/** A response with headers only (204s, HEAD answers, redirects). */
export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number> = {},
): void {
  settleUnreadBody(res.req, res);
  res.writeHead(status, headers);
  res.end();
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    // Too late for a status code (we were already streaming): cut the connection so the client
    // sees a failed transfer rather than a silently truncated body.
    res.destroy();
    return;
  }
  sendJson(res, status, { error: message }, { 'Cache-Control': 'no-store', ...headers });
}

/** Turn anything a handler threw into a response. */
export function sendThrown(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendError(res, err.status, err.message, err.headers);
    return;
  }
  // A client that went away mid-request is not a server error and there is nobody to answer.
  if (res.destroyed || res.socket?.destroyed === true) return;
  console.error('[tandem] request failed:', err);
  sendError(res, 500, 'internal server error');
}

/** 405 with an `Allow` header unless the request uses one of `allowed`. */
export function assertMethod(req: IncomingMessage, allowed: readonly string[]): void {
  if (!allowed.includes(req.method ?? '')) {
    throw new HttpError(405, 'method not allowed', { Allow: allowed.join(', ') });
  }
}

/**
 * Read and parse a JSON object body, enforcing the size cap while streaming.
 * An empty body is treated as `{}` so `POST /api/projects` works without one.
 */
export function readJsonBody(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      reject(new HttpError(413, `request body exceeds ${limit} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;

    // Deliberately not `for await (… of req)`: leaving such a loop early destroys the socket,
    // and then the 413 could never be delivered.
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      req.off('data', onData).off('end', onEnd).off('error', onFail).off('close', onClose);
      finish();
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        settle(() => reject(new HttpError(413, `request body exceeds ${limit} bytes`)));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void =>
      settle(() => {
        if (size === 0) return resolve({});
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return reject(new HttpError(400, 'request body is not valid JSON'));
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'request body must be a JSON object'));
        }
        resolve(parsed as Record<string, unknown>);
      });
    const onFail = (err: Error): void => settle(() => reject(err));
    const onClose = (): void =>
      settle(() => reject(new Error('request aborted before the body was received')));
    const timer = setTimeout(() => {
      settle(() =>
        reject(new HttpError(408, 'timed out waiting for the request body', { Connection: 'close' })),
      );
    }, JSON_BODY_TIMEOUT_MS);

    req.on('data', onData).on('end', onEnd).on('error', onFail).on('close', onClose);
  });
}

/**
 * Stream an open file (or the inclusive byte range `start…end` of it) as the response body.
 * The status line and headers must already have been written. Takes ownership of the handle: it
 * is closed when the transfer ends, however it ends. Never rejects — if the transfer fails the
 * connection is cut, so the client sees an incomplete response rather than a truncated "success".
 */
export async function streamFile(
  res: ServerResponse,
  handle: FileHandle,
  range?: { start: number; end: number },
): Promise<void> {
  try {
    await pipeline(handle.createReadStream(range), res);
  } catch (err) {
    // Players seek and stop all the time by dropping the connection; that is not worth a log line.
    if (!isClientAbort(err)) console.error('[tandem] streaming a file failed:', err);
    res.destroy();
  }
}

/** Parse a non-negative integer header such as `Upload-Offset`. Returns `null` when absent or malformed. */
export function parseIntHeader(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value.trim())) return null;
  return Number(value.trim());
}
