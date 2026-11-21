/**
 * Sound the preview played a clip without.
 *
 * A file's sound can fail to decode in part: a damaged stretch of it, or everything from where
 * the decoder stopped. The clip still plays, silent there, and the mixer says so as it plays
 * (`Player.onAudioProblem`), again every time the clip is played. What it said is kept here by
 * clip, one of a kind, so that the clip can say it where it lies: with a mark on the timeline, in
 * its read-out, and in the inspector.
 */
import {
  clipEnd,
  frameOfMedia,
  mediaAt,
  secondsToFrames,
  type Clip,
  type ID,
  type Project,
} from '@tandem/core';
import type { AudioProblem } from '@tandem/engine';

/** A part of a clip's sound with sound behind it, or everything from some place on. */
export type SoundLossKind = 'stretch' | 'rest';

/** Sound a clip is without, as it is shown. */
export interface SoundGap {
  lost: SoundLossKind;
  /** The frame of the timeline at which the silence begins, where the mixer could say. */
  frame: number | null;
  /** What the decoder said. */
  cause: string;
}

const KINDS: readonly SoundLossKind[] = ['stretch', 'rest'];
/** Seconds: two places this close are one, told apart only by the rounding on their way here. */
const SAME_PLACE = 1e-6;
const NONE: readonly SoundGap[] = [];

interface Loss {
  /**
   * Where the silence begins, in seconds of the clip's file as `Clip.sourceIn` counts them. A
   * place in the file, not on the timeline: the clip can be moved, slipped or trimmed since.
   * Null where the mixer could not say (a clip that plays backwards).
   */
  source: number | null;
  cause: string;
}

/** What was heard of a clip, which was of this file and played this way round then. */
interface Heard {
  assetId: ID;
  reverse: boolean;
  losses: Partial<Record<SoundLossKind, Loss>>;
}

/** Whether the clip is still the one the mixer spoke of: the same file, played the same way round. */
const same = (heard: Heard, clip: Clip | undefined): clip is Clip =>
  !!clip && clip.type === 'audio' && clip.assetId === heard.assetId && clip.reverse === heard.reverse;

/** Whether the clip, as it is now, plays the place in its file where the silence begins. */
function plays(clip: Clip, project: Project, loss: Loss): boolean {
  if (loss.source === null) return true;
  // How many frames into the clip it plays the place, whether or not it reaches that far.
  const at = frameOfMedia(clip, loss.source, project);
  // Along a ramp the way back from a place to its frame is found by iteration, and comes out a
  // hair to either side of a whole frame: a place where the clip ends is not one it plays.
  if (clip.ramp) return at > -1e-6 && at < clip.duration - 1e-6;
  return at > -1e-6 && at < clip.duration;
}

export class SoundLosses {
  private readonly heard = new Map<ID, Heard>();

  /**
   * Take in what the mixer said of a clip of `project`, the project it was playing. Returns
   * whether that was news. Only sound that would not decode is kept: a file that is missing or
   * has no decoder is known by other means, and is the matter of the file, not of the clip.
   */
  note(problem: AudioProblem, project: Project): boolean {
    const clip = project.clips[problem.clipId];
    if (problem.reason !== 'decode-error' || !clip || clip.assetId !== problem.assetId) return false;
    // Nothing of what was asked for is, to a clip that was entered part-way, the rest of it.
    const kind: SoundLossKind = problem.lost === 'stretch' ? 'stretch' : 'rest';
    // The mixer plays a clip on a ramp by the clip's own clock, and says where on the timeline
    // the silence fell: the same clock gives the place in the file.
    const source =
      problem.at === undefined || clip.reverse
        ? null
        : mediaAt(clip, secondsToFrames(problem.at, project.settings) - clip.start, project);
    let heard = this.heard.get(clip.id);
    if (!heard || !same(heard, clip)) {
      heard = { assetId: problem.assetId, reverse: clip.reverse, losses: {} };
      this.heard.set(clip.id, heard);
    }
    const loss: Loss = { source, cause: problem.cause ?? '' };
    // A place the clip does not play, at its end or beyond, is none of the clip's sound.
    if (!plays(clip, project, loss)) return false;
    // One of a kind for a clip, at the first place it was heard: the same however often the clip
    // is played, and from wherever.
    const before = heard.losses[kind];
    const earlier =
      before &&
      plays(clip, project, before) &&
      (source === null || (before.source ?? Infinity) <= source + SAME_PLACE);
    if (earlier) return false;
    heard.losses[kind] = loss;
    return true;
  }

  /** What the clip, as it is in `project`, is known to play without. */
  of(clip: Clip, project: Project): readonly SoundGap[] {
    const heard = this.heard.get(clip.id);
    if (!heard || !same(heard, clip)) return NONE;
    const gaps: SoundGap[] = [];
    for (const lost of KINDS) {
      const loss = heard.losses[lost];
      if (!loss || !plays(clip, project, loss)) continue;
      const frame =
        loss.source === null
          ? null
          : Math.min(
              clipEnd(clip) - 1,
              clip.start + Math.max(0, Math.floor(frameOfMedia(clip, loss.source, project) + 1e-6)),
            );
      gaps.push({ lost, frame, cause: loss.cause });
    }
    return gaps.length ? gaps : NONE;
  }

  /** The file behind an asset changed: what was heard of its clips was heard of another file. */
  forgetAsset(assetId: ID): boolean {
    let changed = false;
    for (const [id, heard] of this.heard) {
      if (heard.assetId !== assetId) continue;
      this.heard.delete(id);
      changed = true;
    }
    return changed;
  }

  /**
   * The project changed: let go of what was heard of clips that are gone, that are of another
   * file now or play the other way round, or that no longer play the place. Whatever is still
   * true of such a clip is said again when it is next played.
   */
  keep(project: Project): boolean {
    let changed = false;
    for (const [id, heard] of this.heard) {
      const clip = project.clips[id];
      if (same(heard, clip)) {
        for (const kind of KINDS) {
          const loss = heard.losses[kind];
          if (!loss || plays(clip, project, loss)) continue;
          delete heard.losses[kind];
          changed = true;
        }
        if (heard.losses.stretch || heard.losses.rest) continue;
      } else changed = true;
      this.heard.delete(id);
    }
    return changed;
  }
}

/** The graver of what a clip is without, which is what its one mark on the timeline says. */
export const gravest = (gaps: readonly SoundGap[]): SoundGap | null =>
  gaps.find((gap) => gap.lost === 'rest') ?? gaps[0] ?? null;
