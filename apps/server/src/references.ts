/**
 * The one thing the server reads out of a project document: which media files it refers to.
 * Everything else in a document is relayed and stored unread. It is read to decide which uploaded
 * files nothing can need any more (see sweep.ts), and for nothing else.
 */
import * as Y from 'yjs';
import { isValidId } from './util';

/**
 * The ids of the assets in a project document: the keys of its `assets` map (`ProjectStore` in
 * @tandem/core keeps one entry per file of the media pool there, under the id the file is
 * uploaded as). A key that could not name a file names none.
 */
export function assetIdsOf(doc: Y.Doc): string[] {
  return Array.from(doc.getMap('assets').keys()).filter(isValidId);
}

/** What a version of a project is stored as: the document, and the assets it refers to. */
export interface VersionContent {
  /** Full document state (`Y.encodeStateAsUpdate`). */
  state: Uint8Array;
  assets: string[];
}

/** The content of a version taken of `doc` as it is now. */
export function versionOf(doc: Y.Doc): VersionContent {
  return { state: Y.encodeStateAsUpdate(doc), assets: assetIdsOf(doc) };
}
