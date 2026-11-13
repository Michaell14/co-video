/** Process entry point: configuration from the environment, startup line, graceful shutdown. */
import { resolve } from 'node:path';
import {
  DEFAULT_MAX_PRESENCE_BYTES,
  DEFAULT_MAX_PROJECT_DOC_BYTES,
  DEFAULT_MAX_REVIEW_DOC_BYTES,
  DEFAULT_MAX_SYNC_BACKLOG_BYTES,
  defaultMaxOpenDocBytes,
} from './limits';
import { DEFAULT_MAX_CONNECTIONS_PER_ROOM } from './rooms';
import {
  DEFAULT_CREATES_PER_HOUR,
  DEFAULT_MAX_CONNECTIONS_PER_IP,
  DEFAULT_UPLOAD_EXPIRY_DAYS,
  SERVER_VERSION,
  createTandemServer,
} from './server';

function fail(message: string): never {
  console.error(`[tandem] ${message}`);
  process.exit(1);
}

function text(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function integer(name: string, fallback: number, min = 0): number {
  const raw = text(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) fail(`${name} must be an integer ≥ ${min}, got "${raw}"`);
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = text(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fail(`${name} must be true or false, got "${raw}"`);
}

const dataDir = resolve(text('DATA_DIR') ?? './data');

const server = await createTandemServer({
  dataDir,
  port: integer('PORT', 8787),
  host: text('HOST') ?? '0.0.0.0',
  corsOrigin: text('CORS_ORIGIN') ?? '*',
  editorDist: text('EDITOR_DIST'),
  siteDist: text('SITE_DIST'),
  maxUploadBytes: integer('MAX_UPLOAD_BYTES', 20 * 1024 ** 3, 1),
  uploadExpiryDays: integer('UPLOAD_EXPIRY_DAYS', DEFAULT_UPLOAD_EXPIRY_DAYS),
  openCreate: flag('TANDEM_OPEN_CREATE', true),
  createsPerHour: integer('MAX_CREATES_PER_HOUR', DEFAULT_CREATES_PER_HOUR, 1),
  autoSnapshotMs: integer('AUTO_SNAPSHOT_MS', 10 * 60 * 1000),
  trustProxy: flag('TRUST_PROXY', false),
  maxConnectionsPerIp: integer('MAX_CONNECTIONS_PER_IP', DEFAULT_MAX_CONNECTIONS_PER_IP, 1),
  maxConnectionsPerRoom: integer('MAX_CONNECTIONS_PER_ROOM', DEFAULT_MAX_CONNECTIONS_PER_ROOM, 1),
  maxProjectDocBytes: integer('MAX_PROJECT_DOC_BYTES', DEFAULT_MAX_PROJECT_DOC_BYTES, 1),
  maxReviewDocBytes: integer('MAX_REVIEW_DOC_BYTES', DEFAULT_MAX_REVIEW_DOC_BYTES, 1),
  maxOpenDocBytes: integer('MAX_OPEN_DOC_BYTES', defaultMaxOpenDocBytes(), 1),
  maxPresenceBytes: integer('MAX_PRESENCE_BYTES', DEFAULT_MAX_PRESENCE_BYTES, 1),
  maxSyncBacklogBytes: integer('MAX_SYNC_BACKLOG_BYTES', DEFAULT_MAX_SYNC_BACKLOG_BYTES, 1),
}).catch((err: unknown) => fail(`could not start: ${err instanceof Error ? err.message : String(err)}`));

console.log(`[tandem] server v${SERVER_VERSION} listening on ${server.url} (data in ${dataDir})`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // A second signal means "now": stop waiting for the flush.
    if (stopping) process.exit(1);
    stopping = true;
    server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('[tandem] shutdown did not complete cleanly:', err);
        process.exit(1);
      },
    );
  });
}
