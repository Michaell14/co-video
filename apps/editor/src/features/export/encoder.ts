/** Asking this browser's video encoder, before an export begins, whether it takes what the export will ask of it. */
import { encoderAccepts, videoEncoding, type VideoEncodingSettings } from '@tandem/engine';
import { highestAccepted, type EncoderVerdict } from './plan';

/** The step in which the dialog's bitrate field counts: a tenth of a megabit. */
const STEP = 1e5;
/** The lowest bitrate the dialog offers, in those steps. */
const LOWEST = 2;

async function verdictOn(e: VideoEncodingSettings): Promise<EncoderVerdict> {
  if (await encoderAccepts(e)) return { accepted: true };
  const limit = await highestAccepted(LOWEST, Math.ceil(e.videoBitrate / STEP), (steps) =>
    encoderAccepts({ ...e, videoBitrate: steps * STEP }),
  );
  const acceleration =
    limit === null &&
    e.hardwareAcceleration !== 'no-preference' &&
    (await encoderAccepts({ ...e, hardwareAcceleration: 'no-preference' }));
  return { accepted: false, limit: limit === null ? null : limit * STEP, acceleration };
}

/**
 * What tells one question to the encoder from another: the set-up the engine makes of the
 * settings, the codec string of a 10-bit picture included. Settings that come to the same set-up
 * are one question.
 */
export const encodingKey = (e: VideoEncodingSettings): string => JSON.stringify(videoEncoding(e));

let last: { key: string; answer: Promise<EncoderVerdict> } | null = null;

/**
 * Whether the encoder takes these settings, and if not, what stands in the way. An encoder has a
 * ceiling on its bitrate that depends on the codec and the picture size (software H.264 stops well
 * short of what the dialog's field takes), and a browser need not have both a GPU and a software
 * encoder for a codec. Refused settings otherwise fail the export only after the person has chosen
 * where to save it.
 *
 * The question itself is the engine's, which puts it to the encoder exactly as its export will.
 * The one asked last is kept with its answer. The dialog asks when the settings change and once
 * more when Export is pressed before the answer is in: both are then given the same one.
 */
export function askEncoder(e: VideoEncodingSettings): Promise<EncoderVerdict> {
  const key = encodingKey(e);
  if (last?.key !== key) last = { key, answer: verdictOn(e) };
  return last.answer;
}
