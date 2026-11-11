/**
 * Capability tokens.
 *
 *   token = base64url(JSON TokenPayload) + "." + base64url(HMAC-SHA256(payloadB64, secret))
 *
 * A token *is* the permission: whoever holds it has the encoded role on the encoded project.
 * There are no accounts and no server-side token list, so tokens cannot be revoked one by one
 * (deleting `<dataDir>/secret` invalidates all of them at once).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Role, TokenPayload } from '@tandem/core';
import { errorCode, isNotFound, isValidId } from './util';

const SECRET_BYTES = 32;
/** Real tokens are ~130 characters; anything much longer is not ours and not worth hashing. */
const MAX_TOKEN_LENGTH = 1024;

const ROLES: readonly Role[] = ['owner', 'editor', 'commenter', 'viewer'];

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);

/** Roles the holder of `role` may hand out. Nobody can mint `owner`; only owners and editors can invite. */
export function invitableRoles(role: Role): readonly Role[] {
  return role === 'owner' || role === 'editor' ? ['editor', 'commenter', 'viewer'] : [];
}

/**
 * Read the signing secret, creating it on first run (32 random bytes, mode 0600).
 * `wx` makes creation exclusive, so two processes racing on first start cannot each write one.
 */
export async function loadOrCreateSecret(dataDir: string): Promise<Buffer> {
  const path = join(dataDir, 'secret');
  let secret: Buffer;
  try {
    secret = await readFile(path);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    const fresh = randomBytes(SECRET_BYTES);
    try {
      await writeFile(path, fresh, { mode: 0o600, flag: 'wx' });
      // The mode passed to open() is filtered by the umask; make sure it really is 0600.
      await chmod(path, 0o600).catch(() => undefined);
      return fresh;
    } catch (writeErr) {
      if (errorCode(writeErr) !== 'EEXIST') throw writeErr;
      secret = await readFile(path);
    }
  }
  if (secret.length < SECRET_BYTES) {
    throw new Error(
      `${path} holds fewer than ${SECRET_BYTES} bytes; refusing to sign tokens with a weak secret`,
    );
  }
  return secret;
}

export class TokenAuthority {
  constructor(private readonly secret: Buffer) {}

  private mac(payloadB64: string): Buffer {
    return createHmac('sha256', this.secret).update(payloadB64).digest();
  }

  sign(payload: TokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${this.mac(body).toString('base64url')}`;
  }

  /** Mint a token granting `role` on `projectId`, issued now. */
  mint(projectId: string, role: Role): string {
    return this.sign({ p: projectId, r: role, iat: Math.floor(Date.now() / 1000) });
  }

  /**
   * Returns the payload if `token` carries a valid signature *and* was issued for `projectId`;
   * `null` otherwise. Never throws.
   */
  verify(token: string | null | undefined, projectId: string): TokenPayload | null {
    if (!token || token.length > MAX_TOKEN_LENGTH) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const body = token.slice(0, dot);
    const signature = token.slice(dot + 1);

    const given = Buffer.from(signature, 'base64url');
    const expected = this.mac(body);
    // timingSafeEqual throws on a length mismatch; the length of a MAC is not a secret.
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    // Node's base64url decoder skips characters it does not know. Insist on the canonical
    // spelling so exactly one string is a valid token for a given payload.
    if (given.toString('base64url') !== signature) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof payload !== 'object' || payload === null) return null;
    const { p, r, iat } = payload as Partial<TokenPayload>;
    if (!isValidId(p) || !isRole(r) || typeof iat !== 'number' || !Number.isFinite(iat)) return null;
    if (p !== projectId) return null;
    return { p, r, iat };
  }
}

/** Token from `Authorization: Bearer …` (preferred) or the `?t=` query parameter. */
export function extractToken(req: IncomingMessage, query: URLSearchParams): string | null {
  const header = req.headers.authorization;
  if (header) {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
    if (match) return match[1];
  }
  return query.get('t');
}
