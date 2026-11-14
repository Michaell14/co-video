/**
 * What is said of media this page cannot decode, wherever it is shown: on a card in the pool, in
 * the inspector, over the picture in the viewer and on a clip in the timeline. Only a decoder
 * that is there and refuses a file makes it a matter of the file and its codec. A page that has
 * no decoder at all is told what is really missing, so that nobody converts a file that is fine.
 */
import type { Asset } from '@tandem/core';
import { decoderGap, type DecoderGap } from '@tandem/engine';
import type { DecodeFault } from '../timeline/mediaCache';

type Part = keyof DecodeFault;

/** What keeps this page from decoding any picture, and any sound: nothing, in most browsers. */
export type DecoderGaps = Record<Part, DecoderGap | null>;

export const decoderGaps = (): DecoderGaps => ({ picture: decoderGap('video'), sound: decoderGap('audio') });

/** The decoder a browser needs for each part of a file, as it is called in a sentence. */
const DECODER = { picture: 'video', sound: 'audio' } as const;

/**
 * Why `what` does not play here, in one sentence without its full stop. `what` is a file by its
 * name or a part of one; `decoder` is the kind of decoder it needs. The sentence is short enough
 * for the one line the viewer has: on an address that is neither HTTPS nor localhost the notice
 * above the editor says the rest.
 */
export function undecodable(what: string, decoder: string, gap: DecoderGap | null): string {
  if (gap === 'insecure') return `This page needs HTTPS to play ${what}`;
  if (gap === 'absent') return `This browser has no ${decoder} decoder to play ${what}`;
  return `This browser cannot decode ${what}`;
}

/**
 * Which part of the file cannot be decoded here. Where the file itself is refused, its codec is
 * named if the file names one: that is what someone needs to know to convert it, or to open the
 * project in a browser that has it. A picture and a sound that fail for different reasons get a
 * sentence each.
 */
export function decodeNotice(
  asset: Pick<Asset, 'videoCodec' | 'audioCodec'>,
  fault: DecodeFault,
  gaps: DecoderGaps = decoderGaps(),
): string {
  const said = (parts: Part[]): string => {
    const gap = gaps[parts[0]];
    const what = `${parts.map((part) => `the ${part}`).join(gap ? ' and ' : ' or ')} of this file`;
    const line = undecodable(what, parts.map((part) => DECODER[part]).join(' or '), gap);
    const codecs = parts
      .map((part) => (part === 'picture' ? asset.videoCodec : asset.audioCodec))
      .filter(Boolean);
    return gap === null && codecs.length ? `${line} (${codecs.join(', ')})` : line;
  };
  const failed = (['picture', 'sound'] as const).filter((part) => fault[part]);
  const alike = failed.length > 1 && gaps.picture === gaps.sound;
  return (alike ? [failed] : failed.map((part) => [part])).map(said).join('. ');
}

/** The same on the chip of a clip in the timeline, where there is room for a word or two. */
export const faultChip = (gap: DecoderGap | null): string =>
  gap === 'insecure' ? 'Needs HTTPS' : gap === 'absent' ? 'No decoder' : 'Unsupported';

/** And in the words that follow a clip's name where the timeline is read out. */
export const faultSpoken = (decoder: string, gap: DecoderGap | null): string =>
  gap === 'insecure'
    ? 'needs HTTPS to play'
    : gap === 'absent'
      ? `no ${decoder} decoder in this browser`
      : 'cannot be decoded in this browser';
