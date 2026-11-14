/** What the viewer says when the picture under the playhead is black for want of its file. */
import { resolveFrame, type Asset, type Project } from '@tandem/core';

/**
 * Why a file has no picture to give: it is on neither this device nor the server, or this browser
 * has no decoder for it.
 */
export type PictureFault = 'offline' | 'undecodable';

export interface MissingPicture {
  /** What the file is called. */
  name: string;
  why: PictureFault;
}

/**
 * The topmost clip on screen at `frame` whose picture cannot be shown, if there is one. `faultOf`
 * says what is wrong with a file, or null for one that is fine or still on its way. Both clips of
 * a transition are on screen, the incoming one on top. A clip whose file is no longer listed in
 * the project at all is offline under the name it took from that file.
 */
export function missingPictureAt(
  project: Project,
  frame: number,
  faultOf: (asset: Asset) => PictureFault | null,
): MissingPicture | null {
  const { layers } = resolveFrame(project, frame);
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    for (const layer of l.kind === 'clip' ? [l.layer] : [l.b, l.a]) {
      const clip = layer?.clip;
      if (!clip?.assetId || (clip.type !== 'video' && clip.type !== 'image')) continue;
      const asset = project.assets[clip.assetId];
      if (!asset) return { name: clip.name, why: 'offline' };
      const why = faultOf(asset);
      if (why) return { name: asset.name, why };
    }
  }
  return null;
}

/** The one line that says it. */
export const pictureNotice = (missing: MissingPicture): string =>
  missing.why === 'offline' ? `Media offline: ${missing.name}` : `This browser cannot decode ${missing.name}`;
