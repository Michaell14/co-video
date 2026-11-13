/** What the interface says about an asset's file, where more than one place has to say the same. */
import type { Asset } from '@tandem/core';
import type { MediaStatus } from '../session/mediaStore';

/**
 * Whether the file of `asset` can be had right now: there is a copy on this device, or the project
 * is shared and the server holds it. An asset whose record is there but whose file is on neither
 * (a project file opened on another device, media that never finished uploading) is offline: the
 * media pool, the timeline and whatever else shows the asset go by this one rule.
 */
export function mediaAvailable(asset: Asset, status: Pick<MediaStatus, 'local'>, shared: boolean): boolean {
  return status.local || (asset.uploaded && shared);
}
