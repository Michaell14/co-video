import {
  Check,
  CircleCheck,
  CornerDownRight,
  MessageSquare,
  MessageSquarePlus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { formatTimecode, initials, type Comment, type ProjectSettings } from '@tandem/core';
import {
  useComments,
  useFrame,
  usePlayer,
  useProject,
  useSession,
  useSessionMeta,
} from '../../session/hooks';
import { cmd } from '../../state/commands';
import { useUI } from '../../state/ui';
import { Button, cx, IconButton, tip } from '../../ui/core';
import { handFocus, usingKeyboard } from '../../ui/layers';
import './collab.css';

function ago(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * The playhead's frame while a comment is pinned to it, and `null` everywhere else: all the list
 * has to know of the playhead. It changes when the playhead comes to a comment or leaves one, not
 * with every frame played, so the list is not rendered again for each of them.
 */
function usePinnedFrame(comments: Comment[]): number | null {
  const player = usePlayer();
  const [pinned, setPinned] = useState<number | null>(null);
  useEffect(() => {
    if (!player) return;
    const look = (at: number) => {
      const frame = Math.floor(at);
      setPinned(comments.some((c) => Math.abs(c.frame - frame) < 1) ? frame : null);
    };
    look(player.getFrame());
    return player.onFrame(look);
  }, [player, comments]);
  return pinned;
}

/** Where a new comment would be pinned: the playhead, as it moves. */
function PlayheadTimecode({ settings }: { settings: ProjectSettings }) {
  return <span className="mono composer__tc">{formatTimecode(useFrame(), settings)}</span>;
}

/**
 * Where the keyboard goes on from an action that takes its own comment out of the list: to the
 * comment that moves up into its place, else to the one before it, else to the box for writing a
 * new one.
 */
function handOn(action: HTMLElement): void {
  const panel = action.closest('.panel');
  const cards = () => Array.from(panel?.querySelectorAll<HTMLElement>('.comment') ?? []);
  const index = cards().findIndex((card) => card.contains(action));
  handFocus(action, () => {
    const left = cards();
    const card = left[index] ?? left[index - 1];
    return (
      card?.querySelector<HTMLElement>('.comment__actions button') ??
      panel?.querySelector<HTMLElement>('.composer textarea')
    );
  });
}

export function CommentsPanel() {
  const session = useSession();
  const meta = useSessionMeta();
  const settings = useProject((p) => p.settings);
  const comments = useComments();
  const [text, setText] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const canComment = session.canComment;
  const open = useMemo(() => comments.filter((c) => !c.resolved), [comments]);
  const list = showResolved ? comments : open;
  const pinned = usePinnedFrame(list);
  const box = useRef<HTMLTextAreaElement>(null);

  const post = () => {
    const body = text.trim();
    if (!body) return;
    session.review.add({
      frame: Math.floor(meta.player?.getFrame() ?? 0),
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
          onClick={(e) => {
            // The panel goes, and this button with it: the keyboard returns to the button in the
            // top bar that brings the panel back.
            handFocus(e.currentTarget, () =>
              document.querySelector<HTMLElement>('.topbar button[aria-label="Comments"]'),
            );
            useUI.getState().set({ commentsOpen: false });
          }}
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
              current={pinned !== null && Math.abs(c.frame - pinned) < 1}
              tc={formatTimecode(c.frame, settings)}
            />
          ))
        )}
      </div>
      <div className="composer">
        <textarea
          ref={box}
          value={text}
          aria-label="Comment at the playhead"
          placeholder={canComment ? 'Add a comment at the playhead…' : 'You have view-only access'}
          disabled={!canComment}
          rows={2}
          onChange={(e) => {
            // A note is about the moment that prompted it. Playback stops with its first
            // character, so the playhead is still on that moment when the note is posted, however
            // long the writing takes.
            if (!text && e.target.value) meta.player?.pause();
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              post();
            }
          }}
        />
        <div className="composer__foot">
          <PlayheadTimecode settings={settings} />
          <Button
            size="sm"
            variant="primary"
            disabled={!canComment || !text.trim()}
            onClick={() => {
              // With nothing left to post the button is switched off, under the keyboard that
              // pressed it: that goes back to the box, where the next note is written.
              if (usingKeyboard()) box.current?.focus();
              post();
            }}
          >
            Comment
          </Button>
        </div>
      </div>
    </>
  );
}

/** Rendered again only when its comment, its timecode or its place under the playhead changes. */
const CommentCard = memo(function CommentCard({
  comment: c,
  current,
  tc,
}: {
  comment: Comment;
  current: boolean;
  tc: string;
}) {
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
        {c.resolved && (
          <span className="comment__done" role="img" aria-label="Resolved" {...tip('Resolved')}>
            <CircleCheck />
          </span>
        )}
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
            aria-label="Reply"
            placeholder="Reply…"
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key !== 'Enter' && e.key !== 'Escape') return;
              e.preventDefault();
              // Sent or given up, the field goes: the keyboard returns to the comment's actions.
              const card = e.currentTarget.closest('.comment');
              handFocus(e.currentTarget, () => card?.querySelector<HTMLElement>('.comment__actions button'));
              if (e.key === 'Enter') send();
              else setReplying(false);
            }}
            onBlur={() => !reply.trim() && setReplying(false)}
          />
        </div>
      ) : (
        canComment && (
          <div className="comment__actions">
            <button onClick={() => setReplying(true)}>Reply</button>
            <button
              onClick={(e) => {
                // Resolved comments leave the list unless they are being shown.
                handOn(e.currentTarget);
                session.review.update(c.id, { resolved: !c.resolved });
              }}
            >
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
              <button
                className="comment__del"
                onClick={(e) => {
                  handOn(e.currentTarget);
                  session.review.remove(c.id);
                }}
              >
                <Trash2 /> Delete
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
});
