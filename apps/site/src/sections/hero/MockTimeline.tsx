import {
  Eye,
  Link2,
  Lock,
  Magnet,
  MessageSquare,
  Minus,
  MousePointer2,
  MoveHorizontal,
  Plus,
  Scissors,
  SlidersHorizontal,
  Type,
} from 'lucide-react';
import { memo } from 'react';
import type { CSSProperties } from 'react';
import { Waveform } from '../../components/Waveform';
import { timecode } from '../../lib/math';
import type { MockEls } from './mockEls';
import { PEOPLE } from './mockEls';
import { CLIPS, CUT, DRONE, TRACKS } from './mockScript';
import type { Clip } from './mockScript';

const RULER_LABELS = [0, 4, 8, 12, 16, 20, 24, 28, 32];

const at = (start: number, dur?: number): CSSProperties =>
  ({ '--start': start, ...(dur === undefined ? {} : { '--dur': dur }) }) as CSSProperties;

function ClipView({ clip, els }: { clip: Clip; els: MockEls }) {
  return (
    <div
      className={`mk-clip mk-clip--${clip.kind}`}
      data-id={clip.id}
      style={at(clip.start, clip.dur)}
      ref={(node) => {
        els.clips[clip.id] = node;
      }}
    >
      {clip.kind === 'video' && (
        <span className="mk-clip__strip" style={{ backgroundImage: `var(--still-${clip.shot ?? 0})` }} />
      )}
      {clip.kind === 'audio' && (
        <Waveform className="mk-clip__wave" seed={clip.seed ?? 1} bars={Math.round(clip.dur * 11)} />
      )}
      <span className="mk-clip__label">
        {clip.kind === 'text' && <Type size={10} strokeWidth={2.2} />}
        {clip.kind === 'adjustment' && <SlidersHorizontal size={10} strokeWidth={2.2} />}
        {clip.name}
      </span>
      {clip.id === CUT.left && (
        <span className="mk-trim">
          <span
            className="mk-trim__badge mono"
            ref={(node) => {
              els.trimBadge = node;
            }}
          >
            +00
          </span>
        </span>
      )}
    </div>
  );
}

/** Bottom panel of the mock: tools, ruler, five tracks, playhead. */
export const MockTimeline = memo(function MockTimeline({ els }: { els: MockEls }) {
  return (
    <div className="mk-tl">
      <div className="mk-tl__toolbar">
        <div className="mk-tools">
          <span className="mk-tool is-active">
            <MousePointer2 size={13} />
          </span>
          <span className="mk-tool">
            <Scissors size={13} />
          </span>
          <span className="mk-tool">
            <MoveHorizontal size={13} />
          </span>
          <span className="mk-tool">
            <Type size={13} />
          </span>
        </div>
        <span className="mk-sep" />
        <span className="mk-toggle is-on">
          <Magnet size={12} />
          Snap
        </span>
        <span className="mk-toggle is-on">
          <Link2 size={12} />
          Linked
        </span>
        <span className="mk-tl__spacer" />
        <span className="mk-zoom">
          <Minus size={12} />
          <span className="mk-zoom__track">
            <span className="mk-zoom__thumb" />
          </span>
          <Plus size={12} />
        </span>
      </div>

      <div className="mk-tl__body">
        <div className="mk-tl__heads">
          <div
            className="mk-tl__corner mono"
            ref={(node) => {
              els.timecodes[1] = node;
            }}
          >
            00:00:03:00
          </div>
          {TRACKS.map((track) => (
            <div key={track.id} className="mk-head" style={{ height: track.height }}>
              <span className="mk-head__label mono">{track.label}</span>
              {track.kind === 'video' ? (
                <span className="mk-head__icons">
                  <Eye size={11} />
                  <Lock size={11} />
                </span>
              ) : (
                <span className="mk-head__icons mk-head__icons--audio mono">
                  <i>M</i>
                  <i>S</i>
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="mk-tl__lanes">
          <div className="mk-ruler">
            {RULER_LABELS.map((sec) => (
              <span key={sec} className="mk-ruler__label mono" style={at(sec)}>
                {timecode(sec).slice(3)}
              </span>
            ))}
            <span className="mk-marker" style={at(6.5)} />
            <span className="mk-pin" style={{ ...at(14.2), '--pin': PEOPLE.aiko.color } as CSSProperties}>
              <MessageSquare size={9} strokeWidth={2.4} />
            </span>
          </div>

          {TRACKS.map((track) => (
            <div
              key={track.id}
              className={`mk-lane mk-lane--${track.kind}`}
              style={{ height: track.height }}
              ref={(node) => {
                els.lanes[track.id] = node;
              }}
            >
              {CLIPS.filter((clip) => clip.track === track.id).map((clip) => (
                <ClipView key={clip.id} clip={clip} els={els} />
              ))}
            </div>
          ))}

          <div
            className="mk-snap"
            style={at(DRONE.snapTo)}
            ref={(node) => {
              els.snapLine = node;
            }}
          />
          <div
            className="mk-playhead"
            ref={(node) => {
              els.playhead = node;
            }}
          >
            <span className="mk-playhead__head" />
          </div>
        </div>
      </div>

      <div className="mk-tl__foot">
        <span className="mk-scroll">
          <span className="mk-scroll__thumb" />
        </span>
      </div>
    </div>
  );
});
