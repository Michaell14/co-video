/**
 * The poster of an imported file, as it goes into the project.
 *
 * Whoever reads a project passes on no poster longer than `MAX_THUMB_LENGTH`, and everyone in it
 * reads the same way: one written longer would travel to everyone and be shown to no one. The
 * engine bounds the posters it makes by their pixels (`posterSize` in its media library), which
 * keeps them well within that length. This is the guard behind it, for a poster that is too long
 * all the same, whatever made it so: it is drawn again with fewer pixels, or left out.
 */
import { MAX_THUMB_LENGTH } from '@tandem/core';

/**
 * How many pixels a poster gets that had to be drawn again: those of a portrait frame at the
 * engine's width, which is also the most the engine gives one. A picture of pure noise that size
 * comes to half of what the readers pass on.
 */
const REDRAWN_PIXELS = 320 * 569;
/** The quality the engine encodes posters with. */
const QUALITY = 0.72;

/** `thumb` as it is if readers will pass it on, or the same picture smaller; `null` if there is none. */
export async function fitPoster(thumb: string | null): Promise<string | null> {
  if (thumb === null || thumb.length <= MAX_THUMB_LENGTH) return thumb;
  try {
    const picture = new Image();
    picture.src = thumb;
    await picture.decode();
    const scale = Math.min(1, Math.sqrt(REDRAWN_PIXELS / (picture.naturalWidth * picture.naturalHeight)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(picture.naturalWidth * scale));
    canvas.height = Math.max(2, Math.round(picture.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
    const drawn = canvas.toDataURL('image/jpeg', QUALITY);
    return drawn.length <= MAX_THUMB_LENGTH ? drawn : null;
  } catch {
    return null;
  }
}
