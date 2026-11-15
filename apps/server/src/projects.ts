/**
 * Project directories and their `meta.json`, and the record of the projects that were deleted.
 *
 *   <dataDir>/projects/<projectId>/   everything a project holds
 *   <dataDir>/deleted/<projectId>     { deletedAt }: the project was deleted by its owner
 *
 * A deleted project leaves its id behind and nothing else. The record is what makes the deletion
 * final: it is written before the first file goes, so a deletion that was cut short is finished
 * the next time the server starts, the id is never given to a new project (the links to the old
 * one are still signed for it), and whoever comes back with such a link is told what happened
 * instead of "not found".
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { newProjectId } from '@tandem/core';
import { HttpError } from './http';
import {
  assertValidId,
  atomicWrite,
  errorCode,
  isNotFound,
  isValidId,
  KeyedQueue,
  readFileIfExists,
} from './util';

export interface ProjectMeta {
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** Milliseconds since the epoch; bumped when a document, version or asset changes. */
  updatedAt: number;
  name: string;
}

/** `updatedAt` is coalesced: however busy a project is, its meta.json is rewritten at most this often. */
const TOUCH_FLUSH_MS = 2000;

/** What a request for a deleted project is told (status 410), and its open connections before they are closed. */
export const PROJECT_DELETED = 'this project was deleted by its owner';
/**
 * The code the connections to a project are closed with when it is deleted. One of the codes a
 * protocol may define for itself (4000 to 4999); the editor knows it by the same number.
 */
export const WS_CLOSE_PROJECT_DELETED = 4410;

export class ProjectStore {
  /** `<dataDir>/projects` */
  readonly root: string;
  /** `<dataDir>/deleted` */
  private readonly graveyard: string;
  /** The ids of the projects that were deleted, as recorded in the graveyard. */
  private readonly deleted = new Set<string>();
  /** Projects whose `updatedAt` moved since it was last written, with the new value. */
  private readonly touched = new Map<string, number>();
  private readonly writes = new KeyedQueue();
  private timer: NodeJS.Timeout | undefined;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'projects');
    this.graveyard = join(dataDir, 'deleted');
  }

  /**
   * Read which projects were deleted, and remove what is still on disk of any of them: a
   * deletion that the process did not live to finish. Call once, before the first request.
   */
  async open(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.graveyard);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    for (const id of names.filter(isValidId)) this.deleted.add(id);
    for (const id of await readdir(this.root)) if (this.deleted.has(id)) await this.remove(id);
  }

  /**
   * Absolute directory of a project. The only place a project id becomes a path, and so the one
   * place that keeps everything from reading or writing the files of a project that was deleted:
   * for such a project it throws the answer the request gets.
   */
  dir(id: string): string {
    assertValidId(id, 'project id');
    if (this.deleted.has(id)) throw new HttpError(410, PROJECT_DELETED);
    return join(this.root, id);
  }

  private metaPath(id: string): string {
    return join(this.dir(id), 'meta.json');
  }

  /** The ids of all projects there are. */
  async list(): Promise<string[]> {
    return (await readdir(this.root)).filter((id) => isValidId(id) && !this.deleted.has(id));
  }

  async create(name: string): Promise<{ id: string; meta: ProjectMeta }> {
    const now = Date.now();
    const meta: ProjectMeta = { createdAt: now, updatedAt: now, name };
    // 20 random base-62 characters do not collide in practice; the loop only makes sure that an
    // existing project can never be taken over by a freshly created one, nor the id of a deleted
    // one by anybody.
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newProjectId();
      if (this.deleted.has(id)) continue;
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
    if (this.deleted.has(id)) return null;
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

  /** Whether the project was deleted by its owner: there was one with this id, and there never will be again. */
  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  /**
   * Record that a project is deleted. Once this resolves the project is gone for every request,
   * whatever is still on disk, and stays gone across restarts. The files are for `remove`, when
   * whoever was writing them has stopped.
   */
  async markDeleted(id: string): Promise<void> {
    assertValidId(id, 'project id');
    if (this.deleted.has(id)) return;
    await mkdir(this.graveyard, { recursive: true });
    await atomicWrite(join(this.graveyard, id), JSON.stringify({ deletedAt: Date.now() }));
    this.deleted.add(id);
    this.touched.delete(id);
  }

  /**
   * Delete everything a project that is recorded as deleted still has on disk. Safe to repeat.
   * It takes its turn behind a write of the project's `meta.json` that is under way.
   */
  remove(id: string): Promise<void> {
    assertValidId(id, 'project id');
    if (!this.deleted.has(id)) throw new Error('only the files of a project recorded as deleted are removed');
    return this.writes.run(id, () =>
      rm(join(this.root, id), { recursive: true, force: true, maxRetries: 3 }),
    );
  }

  /** Record that the project changed just now. Cheap enough to call on every document update. */
  touch(id: string): void {
    if (this.deleted.has(id)) return;
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
            // Deleted while its `meta.json` was being read, the project has no time of a last
            // change left to keep, and the path of the file is no longer handed out.
            if (!meta || meta.updatedAt >= updatedAt || this.deleted.has(id)) return;
            await atomicWrite(this.metaPath(id), JSON.stringify({ ...meta, updatedAt }));
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
