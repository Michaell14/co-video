/**
 * Project lifecycle helpers that do not need the render engine. Kept separate from `session.ts` so
 * the home screen loads without pulling in the compositor, codecs and decoders.
 */
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { newProjectId, ProjectStore, type Project, type ProjectSettings } from '@tandem/core';
import { toast } from '../ui/core';
import { api, serverAvailable } from './api';
import { deleteProjectMedia } from './mediaStore';
import { registry } from './registry';

export const idbName = (id: string, doc: string): string => `tandem:${id}:${doc}`;

// A list that is not kept takes the links of new projects with it when the tab closes, and an
// owner link is made only once. So it is said the moment it happens, wherever in the app that is.
registry.whenUnsaved(() =>
  toast(
    'This browser has no room left to save the project list. Delete a project you no longer need: until then, projects and links added in this tab are lost when it closes.',
    'error',
  ),
);

export function whenSynced(p: IndexeddbPersistence, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    void p.whenSynced.then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Create a brand-new project and return its id. Registers on the server when one is reachable.
 * With `content` (a project file being opened) the new project starts as a copy of it.
 */
export async function createProject(settings: Partial<ProjectSettings>, content?: Project): Promise<string> {
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
  if (content) store.replaceAll(content);
  const idb = new IndexeddbPersistence(idbName(id, 'project'), doc);
  await whenSynced(idb);
  // y-indexeddb writes asynchronously; give the initial state a beat to land before navigating.
  await new Promise((r) => setTimeout(r, 60));
  await idb.destroy();
  const s = store.get().settings;
  registry.upsert({
    id,
    name: s.name,
    token,
    // The server hands the creator an owner token.
    role: token ? 'owner' : undefined,
    width: s.width,
    height: s.height,
    fps: s.fpsNum / s.fpsDen,
  });
  store.destroy();
  doc.destroy();
  return id;
}

/** Remove a project and its media from this device. */
export async function deleteLocalProject(id: string): Promise<void> {
  registry.remove(id);
  // Deleting a project is the person letting go of it, a link the server refused included.
  registry.dropLinkAside(id);
  await deleteProjectMedia(id);
  for (const name of ['project', 'review']) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(idbName(id, name));
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}
