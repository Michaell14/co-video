/**
 * Review document: comments live in their own Yjs doc so people with comment-only access can write
 * here while the project document stays read-only for them.
 *
 * Document layout (top-level Y.Maps, and one Y.Array):
 *   comments        id → the comment as it was posted, one JSON value
 *   commentFields   `${commentId}/${field}` → a later value of text or resolved
 *   commentReplies  `${commentId}/${replyId}` → one JSON reply
 *   commentFrames   a list of `[commentId, frame]`: where comments were moved to
 *
 * Edits and replies get keys of their own instead of rewriting the comment, so two people replying
 * at once, or one resolving while the other replies, both keep what they did. Documents from before
 * this layout carry their replies and edits inside the comment value; those are read in place and
 * anything newer is layered on top, so nothing has to be migrated.
 *
 * Frames have a list instead of keys because they are written far more often than anything else
 * here: an edit that moves time moves every comment after it, and a cut is made of hundreds of
 * such edits. Every value written to a key stays in the document as a struct of its own for good,
 * also once it has been replaced, and a document may only hold so many. The entries of one move
 * are appended together, as one struct, and the entries they replace are deleted, which lets them
 * merge with what the same person deleted before. So a move leaves next to nothing behind, however
 * many comments it moves. Of several entries for one comment the last in the list stands: two
 * people who move the same comment at the same moment each append one, and everyone reads the
 * same one. `commentFields` holds a `${commentId}/frame` in documents from before the list. It is
 * read for a comment the list does not name.
 */
import * as Y from 'yjs';
import { newId } from './ids';
import type { Comment, CommentReply, ID } from './types';
import { hexColor } from './util';

type Listener = () => void;
type Json = Record<string, unknown>;

/** What a comment can have a key for in `commentFields`: the frame only from before `commentFrames`. */
const FIELDS = ['text', 'resolved', 'frame'] as const;
/** Those of them that are still written there. */
const EDITABLE = ['text', 'resolved'] as const;

const UNKNOWN_AUTHOR = { id: '', name: 'Unknown', color: '#64748b' };

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const color = (v: unknown): string => hexColor(v) ?? UNKNOWN_AUTHOR.color;

/** The comment a reply key belongs to. Reply ids never contain a slash; comment ids may. */
const commentOf = (replyKey: string): ID => replyKey.slice(0, Math.max(0, replyKey.lastIndexOf('/')));

/**
 * Commenters can write anything into this document, and everyone else's panel renders it. Both
 * readers return a fully typed value or nothing.
 */
function readReply(id: unknown, json: unknown): CommentReply | null {
  if (typeof id !== 'string' || !isObj(json) || typeof json.text !== 'string') return null;
  return {
    id,
    text: json.text,
    authorId: str(json.authorId, UNKNOWN_AUTHOR.id),
    authorName: str(json.authorName, UNKNOWN_AUTHOR.name),
    authorColor: color(json.authorColor),
    createdAt: isNum(json.createdAt) ? json.createdAt : 0,
  };
}

function readComment(
  id: ID,
  json: unknown,
  edited: (field: (typeof FIELDS)[number]) => unknown,
  later: readonly CommentReply[],
): Comment | null {
  if (!isObj(json) || typeof json.text !== 'string' || !isNum(json.frame)) return null;
  const text = edited('text');
  const frame = edited('frame');
  const resolved = edited('resolved');
  const replies = new Map<ID, CommentReply>();
  for (const r of Array.isArray(json.replies) ? json.replies : []) {
    const reply = readReply(isObj(r) ? r.id : null, r);
    if (reply) replies.set(reply.id, reply);
  }
  for (const reply of later) if (!replies.has(reply.id)) replies.set(reply.id, reply);
  return {
    id,
    frame: isNum(frame) ? frame : json.frame,
    text: typeof text === 'string' ? text : json.text,
    authorId: str(json.authorId, UNKNOWN_AUTHOR.id),
    authorName: str(json.authorName, UNKNOWN_AUTHOR.name),
    authorColor: color(json.authorColor),
    createdAt: isNum(json.createdAt) ? json.createdAt : 0,
    resolved: typeof resolved === 'boolean' ? resolved : json.resolved === true,
    x: isNum(json.x) ? json.x : null,
    y: isNum(json.y) ? json.y : null,
    // Clocks differ between machines; the id settles ties the same way for everyone.
    replies: Array.from(replies.values()).sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    ),
  };
}

export class ReviewStore {
  readonly doc: Y.Doc;
  private readonly yComments: Y.Map<unknown>;
  private readonly yFields: Y.Map<unknown>;
  private readonly yReplies: Y.Map<unknown>;
  private readonly yFrames: Y.Array<unknown>;
  private comments: Comment[] = [];
  private listeners = new Set<Listener>();
  private dirty = false;
  /**
   * Frames that `update` has been given and that are not in the document yet. They go in as one
   * move when the transaction they were given in has ended. A change of frame rate re-times every
   * comment with an `update` of its own, all in one transaction, and entries that are appended to
   * the list one at a time take seconds for a few thousand comments, where appended together they
   * take a few milliseconds.
   */
  private given = new Map<ID, number>();

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.yComments = doc.getMap('comments');
    this.yFields = doc.getMap('commentFields');
    this.yReplies = doc.getMap('commentReplies');
    this.yFrames = doc.getArray('commentFrames');
    this.refresh();
    for (const type of this.types()) type.observe(this.touch);
    doc.on('afterTransaction', this.flush);
    doc.on('afterAllTransactions', this.moveGiven);
  }

  private types(): (Y.Map<unknown> | Y.Array<unknown>)[] {
    return [this.yComments, this.yFields, this.yReplies, this.yFrames];
  }

  private touch = (): void => {
    this.dirty = true;
  };

  /**
   * One refresh and one notification per transaction, however much of the document it wrote to.
   * A change whose frames are still to be written (`given`) is told of once they are.
   */
  private flush = (): void => {
    if (!this.dirty || this.given.size) return;
    this.dirty = false;
    this.refresh();
    for (const fn of Array.from(this.listeners)) fn();
  };

  private moveGiven = (): void => {
    const frames = this.given;
    if (!frames.size) return;
    this.given = new Map();
    this.move(frames);
  };

  private refresh(): void {
    const later = new Map<ID, CommentReply[]>();
    this.yReplies.forEach((value, key) => {
      const reply = readReply(key.slice(key.lastIndexOf('/') + 1), value);
      if (!reply) return;
      const commentId = commentOf(key);
      const list = later.get(commentId);
      if (list) list.push(reply);
      else later.set(commentId, [reply]);
    });
    const moved = new Map<ID, number>();
    this.eachMove((id, frame) => moved.set(id, frame));
    const list: Comment[] = [];
    this.yComments.forEach((value, id) => {
      const edited = (field: (typeof FIELDS)[number]): unknown =>
        field === 'frame' && moved.has(id) ? moved.get(id) : this.yFields.get(`${id}/${field}`);
      const c = readComment(id, value, edited, later.get(id) ?? []);
      if (c) list.push(c);
    });
    list.sort((a, b) => a.frame - b.frame || a.createdAt - b.createdAt);
    this.comments = list;
  }

  /**
   * Every entry of `commentFrames` that reads as one, in the order of the list, with its place in
   * it. Of several for one comment the last stands.
   */
  private eachMove(fn: (id: ID, frame: number, place: number) => void): void {
    this.yFrames.forEach((entry, place) => {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && isNum(entry[1]))
        fn(entry[0], entry[1], place);
    });
  }

  get = (): Comment[] => this.comments;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  add(c: Omit<Comment, 'id' | 'createdAt' | 'resolved' | 'replies'>): ID {
    const id = newId();
    this.yComments.set(id, { ...c, id, createdAt: Date.now(), resolved: false, replies: [] });
    return id;
  }

  reply(id: ID, r: Omit<CommentReply, 'id' | 'createdAt'>): void {
    if (!this.yComments.has(id)) return;
    const replyId = newId(8);
    this.yReplies.set(`${id}/${replyId}`, { ...r, id: replyId, createdAt: Date.now() });
  }

  /**
   * Change what a comment says, whether it is resolved, or the frame it stands at. A frame is
   * written like a move of that one comment (`move`), together with the frames of whatever other
   * comments are updated in the same transaction, when that transaction has ended.
   */
  update(id: ID, patch: Partial<Pick<Comment, 'text' | 'resolved' | 'frame'>>): void {
    const posted = this.yComments.get(id);
    if (!isObj(posted)) return;
    this.doc.transact(() => {
      for (const field of EDITABLE) {
        const value = patch[field];
        if (value === undefined) continue;
        const key = `${id}/${field}`;
        const current = this.yFields.has(key) ? this.yFields.get(key) : posted[field];
        // Writing a value that is already there could still win over someone's concurrent change.
        if (value !== current) this.yFields.set(key, value);
      }
      if (patch.frame !== undefined) this.given.set(id, patch.frame);
    });
  }

  /**
   * Put comments at other frames, by id, as one change: everyone sees them move together, and
   * every list of them is told once. Only frames are written, as entries of `commentFrames` in
   * place of the ones these comments had. A comment's text, its replies and whether it is resolved
   * have keys of their own, and stay whatever anyone makes of them at the same moment.
   */
  move(frames: ReadonlyMap<ID, number>): void {
    if (!frames.size) return;
    this.doc.transact(() => {
      // A frame given before this move, in the same transaction, is not the last word any more.
      for (const id of frames.keys()) this.given.delete(id);
      const stands = new Map<ID, number>();
      const places = new Map<ID, number[]>();
      this.eachMove((id, frame, place) => {
        if (!frames.has(id)) return;
        stands.set(id, frame);
        const before = places.get(id);
        if (before) before.push(place);
        else places.set(id, [place]);
      });
      const entries: [ID, number][] = [];
      const replaced: number[] = [];
      for (const [id, frame] of frames) {
        const posted = this.yComments.get(id);
        if (!isObj(posted) || !isNum(frame)) continue;
        const keyed = this.yFields.get(`${id}/frame`);
        const current = stands.get(id) ?? (isNum(keyed) ? keyed : posted.frame);
        // Writing a value that is already there could still win over someone's concurrent change.
        if (frame === current) continue;
        entries.push([id, frame]);
        replaced.push(...(places.get(id) ?? []));
      }
      this.dropMoves(replaced);
      if (entries.length) this.yFrames.push(entries);
    });
  }

  /**
   * Delete the entries of `commentFrames` at `places`: from the end of the list, so that the
   * places still to come stay what they are, and neighbours in one go. An edit moves the comments
   * from some frame on, whose entries are a stretch of the list, and a list is slow to find a
   * place in once it has been deleted from entry by entry.
   */
  private dropMoves(places: number[]): void {
    places.sort((a, b) => b - a);
    for (let i = 0; i < places.length;) {
      let length = 1;
      while (places[i + length] === places[i] - length) length++;
      this.yFrames.delete(places[i] - length + 1, length);
      i += length;
    }
  }

  remove(id: ID): void {
    this.doc.transact(() => {
      this.yComments.delete(id);
      for (const field of FIELDS) this.yFields.delete(`${id}/${field}`);
      const places: number[] = [];
      this.eachMove((moved, _frame, place) => {
        if (moved === id) places.push(place);
      });
      this.dropMoves(places);
      for (const key of Array.from(this.yReplies.keys())) {
        if (commentOf(key) === id) this.yReplies.delete(key);
      }
    });
  }

  destroy(): void {
    for (const type of this.types()) type.unobserve(this.touch);
    this.doc.off('afterTransaction', this.flush);
    this.doc.off('afterAllTransactions', this.moveGiven);
    this.listeners.clear();
  }
}
