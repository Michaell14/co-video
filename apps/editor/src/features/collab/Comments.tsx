import { Check, CornerDownRight, MessageSquare, MessageSquarePlus, RotateCcw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { formatTimecode, initials, type Comment } from '@tandem/core';
import { useComments, useFrame, useProject, useSession, useSessionMeta } from '../../session/hooks';
import { cmd } from '../../state/commands';
import { useUI } from '../../state/ui';
import { Button, cx, IconButton, tip } from '../../ui/core';
import './collab.css';

function ago(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function CommentsPanel() {
  const session = useSession();
  const meta = useSessionMeta();
  const settings = useProject((p) => p.settings);
  const comments = useComments();
  const frame = useFrame();
  const [text, setText] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const canComment = session.canComment;
  const open = comments.filter((c) => !c.resolved);
  const list = showResolved ? comments : open;

  const post = () => {
    const body = text.trim();
    if (!body) return;
    session.review.add({
      frame,
      text: body,
      authorId: meta.user.id,
      authorName: meta.user.name,
      authorColor: meta.user.color,
      x: null,
      y: null,
    });
    setText('');
  };

  return (
    <>
      <div className="panel__head">
        <MessageSquare size={14} style={{ marginLeft: 8, color: 'var(--fg-3)' }} />
        <div className="panel__title">Comments</div>
        {open.length > 0 && <span className="badge badge--accent">{open.length}</span>}
        <span className="panel__spacer" />
        <button
          className="chip"
          aria-pressed={showResolved}
          onClick={() => setShowResolved(!showResolved)}
          {...tip('Show resolved comments')}
        >
          Resolved
        </button>
        <IconButton
          small
          label="Close comments"
          onClick={() => useUI.getState().set({ commentsOpen: false })}
        >
          <X />
        </IconButton>
      </div>
      <div className="panel__body comments">
        {list.length === 0 ? (
          <div className="empty">
            <MessageSquarePlus />
            <b>{comments.length ? 'All caught up' : 'No comments yet'}</b>
            Leave a note at the playhead. Comments are pinned to a timecode and sync to everyone instantly.
          </div>
        ) : (
          list.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              current={Math.abs(c.frame - frame) < 1}
              tc={formatTimecode(c.frame, settings)}
            />
          ))
        )}
      </div>
      <div className="composer">
        <textarea
          value={text}
          placeholder={canComment ? 'Add a comment at the playhead…' : 'You have view-only access'}
          disabled={!canComment}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              post();
            }
          }}
        />
        <div className="composer__foot">
          <span className="mono composer__tc">{formatTimecode(frame, settings)}</span>
          <Button size="sm" variant="primary" disabled={!canComment || !text.trim()} onClick={post}>
            Comment
          </Button>
        </div>
      </div>
    </>
  );
}

function CommentCard({ comment: c, current, tc }: { comment: Comment; current: boolean; tc: string }) {
  const session = useSession();
  const meta = useSessionMeta();
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const mine = c.authorId === meta.user.id;
  const canComment = session.canComment;
  const send = () => {
    const body = reply.trim();
    if (!body) return;
    session.review.reply(c.id, {
      text: body,
      authorId: meta.user.id,
      authorName: meta.user.name,
      authorColor: meta.user.color,
    });
    setReply('');
    setReplying(false);
  };
  return (
    <div className={cx('comment', c.resolved && 'comment--resolved')} data-current={current}>
      <div className="comment__head">
        <span className="avatar avatar--sm" style={{ background: c.authorColor }}>
          {initials(c.authorName)}
        </span>
        <b>{c.authorName}</b>
        <span className="comment__ago">{ago(c.createdAt)}</span>
        <span style={{ flex: 1 }} />
        <button
          className="comment__tc mono"
          onClick={() => cmd.seek(c.frame)}
          {...tip('Jump to this moment')}
        >
          {tc}
        </button>
      </div>
      <div className="comment__text">{c.text}</div>
      {c.replies.map((r) => (
        <div key={r.id} className="comment__reply">
          <CornerDownRight />
          <div>
            <b style={{ color: r.authorColor }}>{r.authorName}</b>{' '}
            <span className="comment__ago">{ago(r.createdAt)}</span>
            <div>{r.text}</div>
          </div>
        </div>
      ))}
      {replying ? (
        <div className="comment__replybox">
          <input
            autoFocus
            value={reply}
            placeholder="Reply…"
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') send();
              if (e.key === 'Escape') setReplying(false);
            }}
            onBlur={() => !reply.trim() && setReplying(false)}
          />
        </div>
      ) : (
        canComment && (
          <div className="comment__actions">
            <button onClick={() => setReplying(true)}>Reply</button>
            <button onClick={() => session.review.update(c.id, { resolved: !c.resolved })}>
              {c.resolved ? (
                <>
                  <RotateCcw /> Reopen
                </>
              ) : (
                <>
                  <Check /> Resolve
                </>
              )}
            </button>
            {(mine || meta.role === 'owner') && (
              <button className="comment__del" onClick={() => session.review.remove(c.id)}>
                <Trash2 /> Delete
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
