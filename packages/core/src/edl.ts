/**
 * CMX 3600 edit decision list export.
 *
 * An EDL is the lowest common denominator for moving a cut between editors: Resolve, Premiere,
 * Avid and most conform tools read it. It describes one video track and up to four audio tracks as
 * a list of events (source in / out, record in / out). Effects, titles and grades do not survive;
 * transitions are noted in comments and exported as cuts.
 */
import { clipEnd, clipsOnTrack, sourcePerFrame, tracksOf } from './query';
import { formatTimecode, isDropFrame, secondsToFrame } from './time';
import type { Clip, ID, Project } from './types';

export interface EdlOptions {
  /** Video track to export; defaults to the lowest one that holds media. */
  videoTrackId?: ID;
  /** Record timecode of frame 0. Programmes conventionally start at one hour. */
  startTimecodeFrames?: number;
}

/** CMX reel names: eight characters, upper case, no punctuation. `AX` means "auxiliary / file". */
function reelName(name: string): string {
  const clean = name
    .replace(/\.[A-Za-z0-9]{2,5}$/, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '');
  return (clean || 'AX').slice(0, 8);
}

export function toEdl(p: Project, opts: EdlOptions = {}): string {
  const s = p.settings;
  const fps = s.fpsNum / s.fpsDen;
  const offset = opts.startTimecodeFrames ?? Math.round(3600 * fps);
  const { video, audio } = tracksOf(p);
  const isMedia = (c: Clip): boolean => (c.type === 'video' || c.type === 'audio' || c.type === 'image') && !!c.assetId && c.enabled;
  const picture = (opts.videoTrackId ? video.find((t) => t.id === opts.videoTrackId) : undefined) ?? video.find((t) => clipsOnTrack(p, t.id).some(isMedia));
  const sound = audio.filter((t) => clipsOnTrack(p, t.id).some(isMedia)).slice(0, 4);

  const events: { clip: Clip; channel: string }[] = [];
  if (picture) for (const clip of clipsOnTrack(p, picture.id)) if (isMedia(clip)) events.push({ clip, channel: 'V' });
  sound.forEach((t, i) => {
    for (const clip of clipsOnTrack(p, t.id)) if (isMedia(clip)) events.push({ clip, channel: i === 0 ? 'A' : `A${i + 1}` });
  });
  events.sort((a, b) => a.clip.start - b.clip.start || a.channel.localeCompare(b.channel));

  const tc = (frame: number): string => formatTimecode(Math.max(0, Math.round(frame)), s);
  const lines = [`TITLE: ${s.name.replace(/[\r\n]+/g, ' ').slice(0, 70) || 'Untitled'}`, `FCM: ${isDropFrame(s) ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
  events.forEach(({ clip, channel }, i) => {
    const asset = p.assets[clip.assetId!];
    const name = asset?.name ?? 'Missing media';
    const still = clip.type === 'image' || clip.freeze;
    // Source timecode: files are taken to start at zero (embedded timecode is not read).
    const srcIn = secondsToFrame(clip.sourceIn, s);
    const srcFrames = still ? 1 : Math.max(1, Math.round((clip.duration * sourcePerFrame(clip, p) * s.fpsNum) / s.fpsDen));
    const [a, b] = clip.reverse && !still ? [srcIn + srcFrames, srcIn] : [srcIn, srcIn + srcFrames];
    const num = String(i + 1).padStart(3, '0');
    const reel = reelName(name).padEnd(8, ' ');
    lines.push(`${num}  ${reel} ${channel.padEnd(5, ' ')} C        ${tc(Math.min(a, b))} ${tc(Math.max(a, b))} ${tc(offset + clip.start)} ${tc(offset + clipEnd(clip))}`);
    // A motion-effect line carries the playback rate in frames per second (negative = reverse).
    if (still) lines.push(`M2   ${reel}       000.0                ${tc(srcIn)}`);
    else if (clip.speed !== 1 || clip.reverse) {
      const rate = fps * clip.speed * (clip.reverse ? -1 : 1);
      lines.push(`M2   ${reel}       ${(rate < 0 ? '-' : '') + Math.abs(rate).toFixed(1).padStart(5, '0')}                ${tc(clip.reverse ? srcIn + srcFrames : srcIn)}`);
    }
    lines.push(`* FROM CLIP NAME: ${name}`);
    if (clip.transIn) lines.push(`* TRANSITION IN: ${clip.transIn.type} ${clip.transIn.duration} FRAMES (EXPORTED AS A CUT)`);
    if (clip.transOut) lines.push(`* TRANSITION OUT: ${clip.transOut.type} ${clip.transOut.duration} FRAMES (EXPORTED AS A CUT)`);
  });
  return lines.join('\r\n') + '\r\n';
}
