/**
 * Named and automatic versions of the `project` document.
 *
 *   <project>/versions.json        the versions, oldest first: VersionInfo plus `assets`, the ids
 *                                  of the media files the version refers to
 *   <project>/versions/<vid>.bin   full document state (`Y.encodeStateAsUpdate`)
 */
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '@tandem/core';
import type { VersionInfo } from '@tandem/core';
import type { ProjectStore } from './projects';
import type { VersionContent } from './references';
import { assertValidId, atomicWrite, isNotFound, isValidId, KeyedQueue, readFileIfExists } from './util';

/** Automatic versions beyond this many are pruned, oldest first. Named versions are never pruned. */
export const MAX_AUTO_VERSIONS = 50;
export const AUTO_VERSION_NAME = 'Auto-save';

/** A version as the index keeps it. `assets` is missing in entries from before it was recorded. */
interface StoredVersion extends VersionInfo {
  assets?: string[];
}

const isVersionInfo = (value: unknown): value is VersionInfo => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<VersionInfo>;
  return (
    isValidId(v.id) &&
    typeof v.name === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.author === 'string' &&
    typeof v.auto === 'boolean'
  );
};

/** An index entry as it is kept: the fields the API lists, and `assets` when it is a list of ids. */
function readStored(value: unknown): StoredVersion[] {
  if (!isVersionInfo(value)) return [];
  const { id, name, createdAt, author, auto } = value;
  const { assets } = value as StoredVersion;
  const info: VersionInfo = { id, name, createdAt, author, auto };
  return [Array.isArray(assets) && assets.every(isValidId) ? { ...info, assets } : info];
}

/** What the versions of a project refer to, as worked out at one moment. */
export interface VersionReferences {
  /**
   * The ids of the assets some version refers to, or `null` when that could not be told for every
   * version: then nothing is known, and nothing may be concluded.
   */
  assets: ReadonlySet<string> | null;
  /** False once a version was created after `assets` was worked out: it is not covered. */
  current(): boolean;
  /** Stop keeping `current` up to date. Call it when the answer is no longer needed. */
  release(): void;
}

/** Whether an answer of `references` still covers every version of its project. */
interface Answer {
  current: boolean;
}

export class VersionStore {
  /** Serialises index updates per project so concurrent creates cannot lose each other's entry. */
  private readonly queue = new KeyedQueue();
  /** Answers of `references` that are still in use, by project, to be told of a new version. */
  private readonly answers = new Map<string, Set<Answer>>();

  constructor(private readonly projects: ProjectStore) {}

  private indexPath(projectId: string): string {
    return join(this.projects.dir(projectId), 'versions.json');
  }

  /** Path of a version's binary. Throws on a malformed id, so it is safe to call with route params. */
  binPath(projectId: string, versionId: string): string {
    assertValidId(versionId, 'version id');
    return join(this.projects.dir(projectId), 'versions', `${versionId}.bin`);
  }

  private async readIndex(projectId: string): Promise<StoredVersion[]> {
    const raw = await readFileIfExists(this.indexPath(projectId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return Array.isArray(parsed) ? parsed.flatMap(readStored) : [];
  }

  /** All versions, newest first. */
  async list(projectId: string): Promise<VersionInfo[]> {
    const index = await this.readIndex(projectId);
    // Reverse first so that entries with the same timestamp come out latest-created first
    // (Array.prototype.sort is stable).
    return index
      .reverse()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ id, name, createdAt, author, auto }) => ({ id, name, createdAt, author, auto }));
  }

  /**
   * Store `content` as a new version and return its index entry. Call it in the same turn of the
   * event loop the content was taken in: an answer of `references` that does not cover the new
   * version is marked as out of date here and now, before the version is on disk.
   */
  create(
    projectId: string,
    input: { name: string; author: string; auto: boolean },
    content: VersionContent,
  ): Promise<VersionInfo> {
    for (const answer of this.answers.get(projectId) ?? []) answer.current = false;
    return this.queue.run(projectId, async () => {
      const info: VersionInfo = {
        id: newId(),
        name: input.name,
        createdAt: Date.now(),
        author: input.author,
        auto: input.auto,
      };
      // Binary first, index second: a crash in between leaves an unreferenced file, never a
      // listed version without content.
      await mkdir(join(this.projects.dir(projectId), 'versions'), { recursive: true });
      await atomicWrite(this.binPath(projectId, info.id), content.state);

      const index = await this.readIndex(projectId);
      index.push({ ...info, assets: content.assets });
      const pruned = input.auto ? pruneAutoVersions(index) : [];
      await atomicWrite(this.indexPath(projectId), JSON.stringify(index));
      await Promise.all(pruned.map((old) => unlink(this.binPath(projectId, old.id)).catch(() => undefined)));
      return info;
    });
  }

  /**
   * Delete a version. Resolves to whether there was one: deleting what is not there is not an
   * error. The media the version referred to is not touched here; what nothing else refers to
   * goes with the next sweep that finds it old enough.
   */
  remove(projectId: string, versionId: string): Promise<boolean> {
    assertValidId(versionId, 'version id');
    return this.queue.run(projectId, async () => {
      const index = await this.readIndex(projectId);
      const kept = index.filter((version) => version.id !== versionId);
      const listed = kept.length < index.length;
      // Index first, binary second: as when a version is made, a crash in between leaves an
      // unreferenced file and never a listed version without content.
      if (listed) await atomicWrite(this.indexPath(projectId), JSON.stringify(kept));
      await unlink(this.binPath(projectId, versionId)).catch((err: unknown) => {
        if (!isNotFound(err)) throw err;
      });
      return listed;
    });
  }

  /**
   * The assets the versions of a project refer to, every version that was ever asked to be
   * created up to now included. A version stored before the index kept its assets has them read
   * from its content, by `read` (which answers `null` when it cannot), and noted for next time.
   */
  references(projectId: string, read: (state: Uint8Array) => string[] | null): Promise<VersionReferences> {
    // In use from this moment: a version asked for from now on is one the answer may not cover.
    const answer: Answer = { current: true };
    const inUse = this.answers.get(projectId) ?? new Set<Answer>();
    this.answers.set(projectId, inUse.add(answer));
    const release = (): void => {
      inUse.delete(answer);
      if (inUse.size === 0 && this.answers.get(projectId) === inUse) this.answers.delete(projectId);
    };
    // Behind every version that was asked for before, so that the index holds them all.
    const reading = this.queue.run(projectId, async () => {
      const index = await this.readIndex(projectId);
      const assets = new Set<string>();
      let known = true;
      let noted = false;
      for (const version of index) {
        if (!version.assets) {
          const state = await readFileIfExists(this.binPath(projectId, version.id));
          const found = state ? read(state) : [];
          if (!found) {
            known = false;
            continue;
          }
          version.assets = found;
          noted = true;
        }
        for (const id of version.assets) assets.add(id);
      }
      if (noted) await atomicWrite(this.indexPath(projectId), JSON.stringify(index));
      return { assets: known ? assets : null, current: () => answer.current, release };
    });
    reading.catch(release);
    return reading;
  }

  /** Resolves once nothing that was asked of the versions of a project is still being written. */
  settle(projectId: string): Promise<void> {
    return this.queue.run(projectId, async () => undefined);
  }
}

/** Remove the oldest automatic versions from `index` (in place) until at most MAX_AUTO_VERSIONS remain. */
function pruneAutoVersions<T extends VersionInfo>(index: T[]): T[] {
  const autos = index.filter((v) => v.auto).sort((a, b) => a.createdAt - b.createdAt);
  const excess = autos.slice(0, Math.max(0, autos.length - MAX_AUTO_VERSIONS));
  for (const old of excess) index.splice(index.indexOf(old), 1);
  return excess;
}
