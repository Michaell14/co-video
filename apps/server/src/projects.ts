/** Project directories and their `meta.json`. */
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { newProjectId } from '@tandem/core';
import { assertValidId, atomicWrite, errorCode, isValidId, KeyedQueue, readFileIfExists } from './util';

export interface ProjectMeta {
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** Milliseconds since the epoch; bumped when a document, version or asset changes. */
  updatedAt: number;
  name: string;
}

/** `updatedAt` is coalesced: however busy a project is, its meta.json is rewritten at most this often. */
const TOUCH_FLUSH_MS = 2000;

export class ProjectStore {
  /** `<dataDir>/projects` */
  readonly root: string;
  /** Projects whose `updatedAt` moved since it was last written, with the new value. */
  private readonly touched = new Map<string, number>();
  private readonly writes = new KeyedQueue();
  private timer: NodeJS.Timeout | undefined;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'projects');
  }

  /** Absolute directory of a project. The only place a project id becomes a path. */
  dir(id: string): string {
    assertValidId(id, 'project id');
    return join(this.root, id);
  }

  private metaPath(id: string): string {
    return join(this.dir(id), 'meta.json');
  }

  /** The ids of all projects there are. */
  async list(): Promise<string[]> {
    return (await readdir(this.root)).filter(isValidId);
  }

  async create(name: string): Promise<{ id: string; meta: ProjectMeta }> {
    const now = Date.now();
    const meta: ProjectMeta = { createdAt: now, updatedAt: now, name };
    // 20 random base-62 characters do not collide in practice; the loop only makes sure that an
    // existing project can never be taken over by a freshly created one.
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newProjectId();
      try {
        await mkdir(this.dir(id));
      } catch (err) {
        if (errorCode(err) === 'EEXIST') continue;
        throw err;
      }
      await atomicWrite(this.metaPath(id), JSON.stringify(meta));
      return { id, meta };
    }
    throw new Error('could not allocate a project id');
  }

  private async readMeta(id: string): Promise<ProjectMeta | null> {
    const raw = await readFileIfExists(this.metaPath(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw.toString('utf8')) as Partial<ProjectMeta>;
    const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : 0;
    return {
      createdAt,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : createdAt,
      name: typeof parsed.name === 'string' ? parsed.name : '',
    };
  }

  /** The project's metadata, or `null` if there is no such project. */
  async get(id: string): Promise<ProjectMeta | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    const pending = this.touched.get(id);
    return pending === undefined ? meta : { ...meta, updatedAt: Math.max(meta.updatedAt, pending) };
  }

  async exists(id: string): Promise<boolean> {
    return (await this.readMeta(id)) !== null;
  }

  /** Record that the project changed just now. Cheap enough to call on every document update. */
  touch(id: string): void {
    this.touched.set(id, Date.now());
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, TOUCH_FLUSH_MS);
    this.timer.unref();
  }

  /** Write all pending `updatedAt` changes. Called on a timer and on shutdown. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await Promise.all(
      [...this.touched].map(([id, updatedAt]) =>
        this.writes
          .run(id, async () => {
            const meta = await this.readMeta(id);
            if (meta && meta.updatedAt < updatedAt) {
              await atomicWrite(this.metaPath(id), JSON.stringify({ ...meta, updatedAt }));
            }
          })
          .catch((err: unknown) =>
            console.error(`[tandem] could not update meta.json of project ${id}:`, err),
          )
          // Forget the entry only once it is on disk (or hopeless), and only if nothing newer arrived,
          // so `get()` never reports an older `updatedAt` than it did a moment ago.
          .finally(() => {
            if (this.touched.get(id) === updatedAt) this.touched.delete(id);
          }),
      ),
    );
  }
}
