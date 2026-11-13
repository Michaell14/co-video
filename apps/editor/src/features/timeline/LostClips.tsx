import { useEffect, useState } from 'react';
import type { Clip } from '@tandem/core';
import { useSession, useSessionMeta } from '../../session/hooks';
import { commit } from '../../state/props';
import { Button } from '../../ui/core';
import { discardEdits, restoreEdits } from './lostClips';

const sameClips = (a: readonly Clip[], b: readonly Clip[]): boolean =>
  a.length === b.length && a.every((c, i) => c.id === b[i].id);

/**
 * Says so when the project holds clips that no track shows (see `lostClips`), and offers to put
 * them on a track again or to remove them. Only to people who can do either.
 */
export function LostClips() {
  const session = useSession();
  // Access can change while the project is open, and the notice comes and goes with it.
  useSessionMeta();
  const [lost, setLost] = useState<readonly Clip[]>([]);

  useEffect(() => {
    let frame = 0;
    const look = () => {
      frame = 0;
      const now = session.store.hiddenClips();
      setLost((before) => (sameClips(before, now) ? before : now));
    };
    // The store tells its subscribers about the project it shows, which these clips are not part
    // of: so the document is watched, where a collaborator's change and an undo both arrive.
    const later = () => {
      frame ||= requestAnimationFrame(look);
    };
    look();
    session.doc.on('afterTransaction', later);
    return () => {
      session.doc.off('afterTransaction', later);
      cancelAnimationFrame(frame);
    };
  }, [session]);

  if (!lost.length || !session.canEdit) return null;
  // What is done is done to the clips as they are by then, not as they were when last looked at.
  const restore = () => commit(restoreEdits(session.store.get(), session.store.hiddenClips()));
  const discard = () => commit(discardEdits(session.store.hiddenClips()));
  return (
    <div className="tl__lost" role="status">
      <span>
        {lost.length === 1 ? 'A clip has lost its track.' : `${lost.length} clips have lost their track.`}
      </span>
      <Button size="sm" onClick={restore}>
        Restore to a new track
      </Button>
      <Button size="sm" variant="ghost" onClick={discard}>
        Discard
      </Button>
    </div>
  );
}
