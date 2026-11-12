/**
 * Review document: comments live in their own Yjs doc so people with comment-only access can write
 * here while the project document stays read-only for them.
 *
 * Document layout (all top-level Y.Maps):
 *   comments        id → the comment as it was posted, one JSON value
 *   commentFields   `${commentId}/${field}` → a later value of text, resolved or frame
 *   commentReplies  `${commentId}/${replyId}` → one JSON reply
 *
 * Edits and replies get keys of their own instead of rewriting the comment, so two people replying
 * at once, or one resolving while the other replies, both keep what they did. Documents from before
 * this layout carry their replies and edits inside the comment value; those are read in place and
 * anything newer is layered on top, so nothing has to be migrated.
 */
import * as Y from 'yjs';
import { newId } from './ids';
import type { Comment, CommentReply, ID } from './types';
import { hexColor } from './util';

type Listener = () => void;
type Json = Record<string, unknown>;

const EDITABLE = ['text', 'resolved', 'frame'] as const;

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
  edited: (field: (typeof EDITABLE)[number]) => unknown,
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
  private comments: Comment[] = [];
  private listeners = new Set<Listener>();
  private dirty = false;

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.yComments = doc.getMap('comments');
    this.yFields = doc.getMap('commentFields');
    this.yReplies = doc.getMap('commentReplies');
    this.refresh();
    for (const map of [this.yComments, this.yFields, this.yReplies]) map.observe(this.touch);
    doc.on('afterTransaction', this.flush);
  }

  private touch = (): void => {
    this.dirty = true;
  };

  /** One refresh and one notification per transaction, however many maps it wrote to. */
  private flush = (): void => {
    if (!this.dirty) return;
    this.dirty = false;
    this.refresh();
    for (const fn of Array.from(this.listeners)) fn();
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
    const list: Comment[] = [];
    this.yComments.forEach((value, id) => {
      const c = readComment(id, value, (field) => this.yFields.get(`${id}/${field}`), later.get(id) ?? []);
      if (c) list.push(c);
    });
    list.sort((a, b) => a.frame - b.frame || a.createdAt - b.createdAt);
    this.comments = list;
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
    });
  }

  remove(id: ID): void {
    this.doc.transact(() => {
      this.yComments.delete(id);
      for (const field of EDITABLE) this.yFields.delete(`${id}/${field}`);
      for (const key of Array.from(this.yReplies.keys())) {
        if (commentOf(key) === id) this.yReplies.delete(key);
      }
    });
  }

  destroy(): void {
    for (const map of [this.yComments, this.yFields, this.yReplies]) map.unobserve(this.touch);
    this.doc.off('afterTransaction', this.flush);
    this.listeners.clear();
  }
}
