/** What is said of a file this browser has no decoder for, wherever the file is shown. */
import type { Asset } from '@tandem/core';
import type { DecodeFault } from '../timeline/mediaCache';

/**
 * Which part of the file cannot be decoded here, with the codec where the file names one: that is
 * what someone needs to know to convert it, or to open the project in a browser that has it.
 */
export function decodeNotice(asset: Pick<Asset, 'videoCodec' | 'audioCodec'>, fault: DecodeFault): string {
  const part = fault.picture && fault.sound ? 'picture or the sound' : fault.picture ? 'picture' : 'sound';
  const codecs = [fault.picture && asset.videoCodec, fault.sound && asset.audioCodec].filter(Boolean);
  return `This browser cannot decode the ${part} of this file${codecs.length ? ` (${codecs.join(', ')})` : ''}`;
}
