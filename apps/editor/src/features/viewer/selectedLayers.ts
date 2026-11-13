import { resolveFrame, type ClipLayer, type ID, type Project } from '@tandem/core';

/**
 * The selected clips that are on screen at `frame` and can be laid out by hand, as the layers they
 * are drawn as and in the order they were selected. Sound and adjustment layers have no box, and
 * a locked track is not to be touched.
 *
 * The frame is resolved once for the whole selection, and not at all when nothing in it could be
 * shown: asked once per selected clip it was what a step of the playhead cost with a few thousand
 * clips selected.
 */
export function selectedLayers(project: Project, frame: number, selection: readonly ID[]): ClipLayer[] {
  let shown: Map<ID, ClipLayer> | null = null;
  const found: ClipLayer[] = [];
  for (const id of selection) {
    const clip = project.clips[id];
    if (!clip || clip.type === 'audio' || clip.type === 'adjustment') continue;
    if (project.tracks[clip.trackId]?.locked) continue;
    shown ??= layersByClip(project, frame);
    const layer = shown.get(id);
    if (layer) found.push(layer);
  }
  return found;
}

/** The layer each clip on screen at `frame` is drawn as: both sides of a transition are on screen. */
function layersByClip(project: Project, frame: number): Map<ID, ClipLayer> {
  const shown = new Map<ID, ClipLayer>();
  for (const l of resolveFrame(project, frame).layers) {
    for (const layer of l.kind === 'clip' ? [l.layer] : [l.a, l.b]) {
      if (layer && !shown.has(layer.clip.id)) shown.set(layer.clip.id, layer);
    }
  }
  return shown;
}
