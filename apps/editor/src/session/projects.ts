/**
 * Project lifecycle helpers that do not need the render engine. Kept separate from `session.ts` so
 * the home screen loads without pulling in the compositor, codecs and decoders.
 */
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { newProjectId, ProjectStore, type ProjectSettings } from '@tandem/core';
import { api, serverAvailable } from './api';
import { deleteProjectMedia } from './mediaStore';
import { registry } from './registry';

export const idbName = (id: string, doc: string): string => `tandem:${id}:${doc}`;

export function whenSynced(p: IndexeddbPersistence, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    void p.whenSynced.then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Create a brand-new project and return its id. Registers on the server when one is reachable. */
export async function createProject(settings: Partial<ProjectSettings>): Promise<string> {
  let id = newProjectId();
  let token: string | null = null;
  if (await serverAvailable()) {
    try {
      const res = await api.createProject(settings.name ?? 'Untitled project');
      id = res.id;
      token = res.token;
    } catch (err) {
      console.warn('[project] server project creation failed; staying local', err);
    }
  }
  const doc = new Y.Doc();
  const store = new ProjectStore(doc);
  store.initIfEmpty(settings);
  const idb = new IndexeddbPersistence(idbName(id, 'project'), doc);
  await whenSynced(idb);
  // y-indexeddb writes asynchronously; give the initial state a beat to land before navigating.
  await new Promise((r) => setTimeout(r, 60));
  await idb.destroy();
  const s = store.get().settings;
  registry.upsert({ id, name: s.name, token, width: s.width, height: s.height, fps: s.fpsNum / s.fpsDen });
  store.destroy();
  doc.destroy();
  return id;
}

/** Remove a project and its media from this device. */
export async function deleteLocalProject(id: string): Promise<void> {
  registry.remove(id);
  await deleteProjectMedia(id);
  for (const name of ['project', 'review']) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(idbName(id, name));
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}
