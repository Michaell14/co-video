/** What the timeline says about its clips to someone who cannot see them. */
import {
  clipEnd,
  displayTracks,
  formatTimecode,
  trackLabel,
  type Clip,
  type ID,
  type Project,
} from '@tandem/core';
import type { DecoderGap } from '@tandem/engine';
import { faultSpoken } from '../library/fault';

/** A frame as it is read out: minutes, seconds and frames, with hours only when there are any. */
export function spokenTime(frame: number, settings: Project['settings']): string {
  const [hours, minutes, seconds, frames] = formatTimecode(frame, settings).split(/[:;]/);
  const head = Number(hours) > 0 ? `${Number(hours)}:${minutes}` : `${Number(minutes)}`;
  return `${head}:${seconds}.${frames}`;
}

/** The name a clip goes by: what a title says, else the name of its media, else what kind it is. */
export function clipName(clip: Clip): string {
  if (clip.type === 'text' && clip.text) return clip.text.content.replace(/\s+/g, ' ').trim() || 'Text';
  return clip.name || clip.type;
}

/** What is wrong with a clip, in the words that follow its name: nothing, for most clips. */
export interface ClipTrouble {
  /** Its media cannot be had, on this device or from the server. */
  offline?: boolean;
  /** Its picture, or its sound, cannot be decoded on this page. */
  undecodable?: boolean;
  /** What keeps the page from decoding any picture, or any sound, where that is why. */
  gap?: DecoderGap | null;
  /** It shares frames with another clip of its track. */
  overlapping?: boolean;
}

/** A clip in words: its name, its track and the time it takes up, and anything wrong with it. */
export function describeClip(
  clip: Clip,
  track: string,
  settings: Project['settings'],
  trouble: ClipTrouble = {},
): string {
  const parts = [
    clipName(clip),
    track,
    `${spokenTime(clip.start, settings)} to ${spokenTime(clipEnd(clip), settings)}`,
  ];
  if (!clip.enabled) parts.push('disabled');
  if (trouble.offline) parts.push('media offline');
  if (trouble.undecodable) {
    parts.push(faultSpoken(clip.type === 'audio' ? 'audio' : 'video', trouble.gap ?? null));
  }
  if (trouble.overlapping) parts.push('overlaps another clip');
  return parts.join(', ');
}

/**
 * The selection in words, for when it changes without anything on screen being pointed at. One
 * clip is described; so is a clip selected together with what it is linked to, which is one thing
 * to whoever selected it. Anything else is counted.
 */
export function describeSelection(p: Project, ids: readonly ID[]): string {
  const order = new Map(displayTracks(p).map((t, i) => [t.id, i]));
  const clips = ids
    .map((id) => p.clips[id])
    .filter((c): c is Clip => !!c)
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.start - b.start);
  if (!clips.length) return 'No clip selected';
  const [first] = clips;
  const group = first.linkId !== null && clips.every((c) => c.linkId === first.linkId);
  if (clips.length > 1 && !group) return `${clips.length} clips selected`;
  const track = p.tracks[first.trackId];
  const said = describeClip(first, track ? trackLabel(p, track) : '', p.settings);
  const linked = clips.length - 1;
  return linked ? `${said}, with ${linked === 1 ? 'its linked clip' : `${linked} linked clips`}` : said;
}
