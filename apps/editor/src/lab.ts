/**
 * Engine lab: a bare page that exposes the render engine to automated tests (and to curious
 * developers in the console) without any editor UI in the way. Dev-only; not part of the build.
 */
import * as core from '@tandem/core';
import * as engine from '@tandem/engine';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const files = new Map<string, Blob>();

const resolver: engine.MediaResolver = async (id) => {
  const blob = files.get(id);
  return blob ? { blob } : null;
};

const lab = {
  core,
  engine,
  canvas,
  files,
  resolver,
  compositor: null as engine.Compositor | null,
  sources: null as engine.SourceManager | null,
  library: null as engine.MediaLibrary | null,

  init(width = 640, height = 360) {
    this.sources?.dispose();
    this.library?.dispose();
    this.compositor?.dispose();
    this.compositor = new engine.Compositor(canvas);
    this.compositor.setSize(width, height);
    this.library = new engine.MediaLibrary(resolver);
    this.sources = new engine.SourceManager(this.compositor.glx, this.library);
    return this.compositor.glx.caps;
  },

  /** Compile every shader in the effect / transition libraries. Returns the ids that failed. */
  compileAll(): string[] {
    if (!this.compositor) this.init();
    return engine.compileAll(this.compositor!.glx, core.EFFECTS, core.TRANSITIONS);
  },

  async addFile(id: string, url: string, name: string): Promise<core.Asset> {
    const res = await fetch(url);
    const blob = await res.blob();
    const file = new File([blob], name, { type: blob.type });
    files.set(id, file);
    const probe = await engine.probeFile(file);
    return { ...probe.asset, id, createdAt: 0, createdBy: 'lab', folderId: null, uploaded: false };
  },

  /** Render one frame exactly and return canvas-space RGBA pixels (top row first). */
  async renderFrame(project: core.Project, frame: number, opts: engine.RenderOptions = {}) {
    if (!this.compositor) this.init();
    const c = this.compositor!;
    const desc = core.resolveFrame(project, frame);
    await this.sources!.prepare(project, desc, true, c.width, c.height);
    const stats = c.render(project, desc, this.sources!, opts);
    return { stats, pixels: c.readPixels(), width: c.width, height: c.height };
  },

  /** Register the editor's title typefaces. As in the editor, each is fetched on first use. */
  async registerTitleFonts(): Promise<void> {
    await import('./fonts');
  },

  /** Average colour of a rectangle of the last render, 0…255. */
  sample(pixels: Uint8Array, width: number, x: number, y: number, w = 4, h = 4): number[] {
    const acc = [0, 0, 0, 0];
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        const o = (j * width + i) * 4;
        for (let k = 0; k < 4; k++) acc[k] += pixels[o + k];
      }
    }
    return acc.map((v) => Math.round(v / (w * h)));
  },
};

declare global {
  interface Window {
    lab: typeof lab;
  }
}
window.lab = lab;
document.title = 'lab-ready';

Object.assign(lab, {
  /** Export a project and return the encoded file as a base64 string (tests only: small files). */
  async exportBase64(project: core.Project, settings: engine.ExportSettings) {
    const progress: engine.ExportProgress[] = [];
    const reported: engine.ExportWarning[] = [];
    const result = await engine.exportProject(project, resolver, settings, {
      onProgress: (p) => progress.push({ ...p }),
      onWarning: (w) => reported.push(w),
    });
    const buf = new Uint8Array(await result.blob!.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return {
      base64: btoa(bin),
      mimeType: result.mimeType,
      extension: result.extension,
      frames: result.frames,
      seconds: result.seconds,
      phases: Array.from(new Set(progress.map((p) => p.phase))),
      warnings: result.warnings,
      reported,
    };
  },
});
