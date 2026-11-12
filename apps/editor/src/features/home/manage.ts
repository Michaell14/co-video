/**
 * What the home screen does to a project without opening it in the editor: rename it, copy it, or
 * make one from a project file. Each works on the copy this device keeps, so none of it needs the
 * render engine or a connection.
 */
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { parseProjectFile, ProjectStore, type Project } from '@tandem/core';
import { copyProjectMedia } from '../../session/mediaStore';
import { createProject, idbName, whenSynced } from '../../session/projects';
import { registry, type ProjectEntry } from '../../session/registry';

/** Run `fn` on the stored copy of a project. Whatever it commits is on the device when this resolves. */
async function withStored<T>(id: string, fn: (store: ProjectStore) => T): Promise<T> {
  const doc = new Y.Doc();
  const store = new ProjectStore(doc);
  const idb = new IndexeddbPersistence(idbName(id, 'project'), doc);
  await whenSynced(idb);
  try {
    return fn(store);
  } finally {
    // Closing the database waits for the writes already under way.
    await idb.destroy();
    store.destroy();
    doc.destroy();
  }
}

/** A new project is its own: nothing of it is on the server yet, whatever its source says. */
function notUploaded(project: Project): Project {
  const assets = Object.values(project.assets).map((a) => [a.id, { ...a, uploaded: false }]);
  return { ...project, assets: Object.fromEntries(assets) };
}

const NEVER_OPENED = 'Open this project once on this device first: nothing of it is stored here yet.';

/**
 * Rename a project on this device. In a shared project the new name reaches the others the next
 * time it is opened, like any other edit made offline.
 */
export async function renameProject(entry: ProjectEntry, name: string): Promise<void> {
  const next = name.trim();
  if (!next || next === entry.name) return;
  const renamed = await withStored(entry.id, (store) => {
    if (store.isEmpty()) return false;
    store.commit([{ op: 'settings', patch: { name: next } }], { undoable: false });
    return true;
  });
  if (!renamed) throw new Error(NEVER_OPENED);
  registry.upsert({ id: entry.id, name: next, updatedAt: Date.now() });
}

/**
 * Copy a project, with the media this device holds for it, into a new project of its own. Returns
 * the copy's id.
 */
export async function duplicateProject(entry: ProjectEntry): Promise<string> {
  const source = await withStored(entry.id, (store) => (store.isEmpty() ? null : store.get()));
  if (!source) throw new Error(NEVER_OPENED);
  const name = `${source.settings.name} copy`;
  const copy = notUploaded({ ...source, settings: { ...source.settings, name } });
  const id = await createProject(copy.settings, copy);
  const media = Object.keys(copy.assets);
  if (media.length) await copyProjectMedia(entry.id, id, media);
  registry.upsert({ id, thumb: entry.thumb, duration: entry.duration });
  return id;
}

/** Make a project from a `.tandem` file. Null when the file is not one. */
export async function projectFromFile(file: File): Promise<{ id: string; project: Project } | null> {
  const parsed = parseProjectFile(await file.text());
  if (!parsed) return null;
  const project = notUploaded(parsed);
  return { id: await createProject(project.settings, project), project };
}
