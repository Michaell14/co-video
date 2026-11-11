/**
 * Named and automatic versions of the `project` document.
 *
 *   <project>/versions.json        VersionInfo[] (oldest first)
 *   <project>/versions/<vid>.bin   full document state (`Y.encodeStateAsUpdate`)
 */
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '@tandem/core';
import type { VersionInfo } from '@tandem/core';
import type { ProjectStore } from './projects';
import { assertValidId, atomicWrite, isValidId, KeyedQueue, readFileIfExists } from './util';

/** Automatic versions beyond this many are pruned, oldest first. Named versions are never pruned. */
export const MAX_AUTO_VERSIONS = 50;
export const AUTO_VERSION_NAME = 'Auto-save';

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

export class VersionStore {
  /** Serialises index updates per project so concurrent creates cannot lose each other's entry. */
  private readonly queue = new KeyedQueue();

  constructor(private readonly projects: ProjectStore) {}

  private indexPath(projectId: string): string {
    return join(this.projects.dir(projectId), 'versions.json');
  }

  /** Path of a version's binary. Throws on a malformed id, so it is safe to call with route params. */
  binPath(projectId: string, versionId: string): string {
    assertValidId(versionId, 'version id');
    return join(this.projects.dir(projectId), 'versions', `${versionId}.bin`);
  }

  private async readIndex(projectId: string): Promise<VersionInfo[]> {
    const raw = await readFileIfExists(this.indexPath(projectId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return Array.isArray(parsed) ? parsed.filter(isVersionInfo) : [];
  }

  /** All versions, newest first. */
  async list(projectId: string): Promise<VersionInfo[]> {
    const index = await this.readIndex(projectId);
    // Reverse first so that entries with the same timestamp come out latest-created first
    // (Array.prototype.sort is stable).
    return index.reverse().sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Store `state` as a new version and return its index entry. */
  create(
    projectId: string,
    input: { name: string; author: string; auto: boolean },
    state: Uint8Array,
  ): Promise<VersionInfo> {
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
      await atomicWrite(this.binPath(projectId, info.id), state);

      const index = await this.readIndex(projectId);
      index.push(info);
      const pruned = input.auto ? pruneAutoVersions(index) : [];
      await atomicWrite(this.indexPath(projectId), JSON.stringify(index));
      await Promise.all(pruned.map((old) => unlink(this.binPath(projectId, old.id)).catch(() => undefined)));
      return info;
    });
  }
}

/** Remove the oldest automatic versions from `index` (in place) until at most MAX_AUTO_VERSIONS remain. */
function pruneAutoVersions(index: VersionInfo[]): VersionInfo[] {
  const autos = index.filter((v) => v.auto).sort((a, b) => a.createdAt - b.createdAt);
  const excess = autos.slice(0, Math.max(0, autos.length - MAX_AUTO_VERSIONS));
  for (const old of excess) index.splice(index.indexOf(old), 1);
  return excess;
}
