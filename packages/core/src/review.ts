/**
 * Review document: comments live in their own Yjs doc so people with comment-only access can write
 * here while the project document stays read-only for them.
 */
import * as Y from 'yjs';
import { newId } from './ids';
import type { Comment, CommentReply, ID } from './types';

type Listener = () => void;

export class ReviewStore {
  readonly doc: Y.Doc;
  private readonly yComments: Y.Map<Comment>;
  private comments: Comment[] = [];
  private listeners = new Set<Listener>();

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.yComments = doc.getMap('comments');
    this.refresh();
    this.yComments.observe(() => {
      this.refresh();
      for (const fn of Array.from(this.listeners)) fn();
    });
  }

  private refresh(): void {
    const list: Comment[] = [];
    this.yComments.forEach((c, id) => {
      if (c && typeof c === 'object' && typeof c.text === 'string' && typeof c.frame === 'number') {
        list.push({ ...c, id, replies: Array.isArray(c.replies) ? c.replies : [] });
      }
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
    const c = this.yComments.get(id);
    if (!c) return;
    this.yComments.set(id, {
      ...c,
      replies: [...(c.replies ?? []), { ...r, id: newId(8), createdAt: Date.now() }],
    });
  }

  update(id: ID, patch: Partial<Pick<Comment, 'text' | 'resolved' | 'frame'>>): void {
    const c = this.yComments.get(id);
    if (c) this.yComments.set(id, { ...c, ...patch });
  }

  remove(id: ID): void {
    this.yComments.delete(id);
  }

  destroy(): void {
    this.listeners.clear();
  }
}
