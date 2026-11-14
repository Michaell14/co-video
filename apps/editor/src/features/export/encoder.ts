/** Asking this browser's video encoder, before an export begins, whether it takes what the export will ask of it. */
import { canEncodeVideo } from 'mediabunny';
import type { ExportSettings } from '@tandem/engine';
import { highestAccepted, type EncoderVerdict } from './plan';

/** What of an export's settings its video encoder is configured with. */
export type Encoding = Pick<
  ExportSettings,
  'videoCodec' | 'width' | 'height' | 'videoBitrate' | 'fpsNum' | 'fpsDen' | 'hardwareAcceleration'
>;

/** The step in which the dialog's bitrate field counts: a tenth of a megabit. */
const STEP = 1e5;
/** The lowest bitrate the dialog offers, in those steps. */
const LOWEST = 2;

/**
 * The question `exportProject` puts to the encoder when the first frame arrives, asked ahead of
 * it: the same codec, size, bitrate, frame rate and choice of encoder, for an 8-bit picture. (A
 * 10-bit one is encoded under a codec string that the engine makes up for itself and does not
 * hand out, so it cannot be asked about from here.)
 */
const accepts = (e: Encoding): Promise<boolean> =>
  canEncodeVideo(e.videoCodec, {
    width: e.width,
    height: e.height,
    bitrate: e.videoBitrate,
    frameRate: e.fpsNum / e.fpsDen,
    hardwareAcceleration: e.hardwareAcceleration,
    latencyMode: 'quality',
  }).catch(() => false);

async function verdictOn(e: Encoding): Promise<EncoderVerdict> {
  if (await accepts(e)) return { accepted: true };
  const limit = await highestAccepted(LOWEST, Math.ceil(e.videoBitrate / STEP), (steps) =>
    accepts({ ...e, videoBitrate: steps * STEP }),
  );
  const acceleration =
    limit === null &&
    e.hardwareAcceleration !== 'no-preference' &&
    (await accepts({ ...e, hardwareAcceleration: 'no-preference' }));
  return { accepted: false, limit: limit === null ? null : limit * STEP, acceleration };
}

let last: { key: string; answer: Promise<EncoderVerdict> } | null = null;

/**
 * Whether the encoder takes these settings, and if not, what stands in the way. An encoder has a
 * ceiling on its bitrate that depends on the codec and the picture size (software H.264 stops well
 * short of what the dialog's field takes), and a browser need not have both a GPU and a software
 * encoder for a codec. Refused settings otherwise fail the export only after the person has chosen
 * where to save it.
 *
 * The question asked last is kept with its answer. The dialog asks when the settings change and
 * once more when Export is pressed before the answer is in: both are then given the same one.
 */
export function askEncoder(e: Encoding): Promise<EncoderVerdict> {
  const key = [
    e.videoCodec,
    e.width,
    e.height,
    e.videoBitrate,
    e.fpsNum,
    e.fpsDen,
    e.hardwareAcceleration,
  ].join('|');
  if (last?.key !== key) last = { key, answer: verdictOn(e) };
  return last.answer;
}
