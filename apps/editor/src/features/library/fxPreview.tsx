/**
 * Live thumbnails for the effect and transition browsers, rendered with the real shaders on a tiny
 * shared WebGL context. Transitions animate on hover so you can see what they do before using them.
 */
import { useEffect, useRef, useState } from 'react';
import { defaultParams, getEffectDef, getTransitionDef, resolveParams, easeProgress } from '@tandem/core';
import { COPY_FS, Glx, PRESENT_VS, runEffect, transitionProgram } from '@tandem/engine';

const W = 160;
const H = 90;

interface Stage {
  glx: Glx;
  canvas: OffscreenCanvas | HTMLCanvasElement;
  a: WebGLTexture;
  b: WebGLTexture;
}

let stage: Stage | null | undefined;

function sample(variant: 0 | 1): OffscreenCanvas | HTMLCanvasElement {
  const c =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const sky = g.createLinearGradient(0, 0, 0, H);
  if (variant === 0) {
    sky.addColorStop(0, '#1b2a6b');
    sky.addColorStop(0.55, '#e0568a');
    sky.addColorStop(1, '#ffb347');
  } else {
    sky.addColorStop(0, '#0b3d4f');
    sky.addColorStop(0.6, '#2fb58c');
    sky.addColorStop(1, '#d7f171');
  }
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  // Sun / moon
  g.fillStyle = variant === 0 ? '#fff4c2' : '#f4fbff';
  g.beginPath();
  g.arc(variant === 0 ? 112 : 48, variant === 0 ? 40 : 30, 14, 0, Math.PI * 2);
  g.fill();
  // Hills
  g.fillStyle = variant === 0 ? '#23113f' : '#06262f';
  g.beginPath();
  g.moveTo(0, H);
  g.lineTo(0, 62);
  g.quadraticCurveTo(40, 40, 80, 64);
  g.quadraticCurveTo(120, 84, W, 54);
  g.lineTo(W, H);
  g.fill();
  g.fillStyle = variant === 0 ? '#3a1c5c' : '#0d4a4a';
  g.beginPath();
  g.moveTo(0, H);
  g.lineTo(0, 78);
  g.quadraticCurveTo(60, 60, 110, 80);
  g.quadraticCurveTo(140, 90, W, 74);
  g.lineTo(W, H);
  g.fill();
  return c;
}

function getStage(): Stage | null {
  if (stage !== undefined) return stage;
  try {
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(W, H)
        : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) return (stage = null);
    const glx = new Glx(gl, false);
    const upload = (src: OffscreenCanvas | HTMLCanvasElement) => {
      const tex = glx.createTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      return tex;
    };
    stage = { glx, canvas, a: upload(sample(0)), b: upload(sample(1)) };
  } catch {
    stage = null;
  }
  return stage;
}

/** Draw a preview into `target`. `t` is 0…1 (transition progress, or animation phase for effects). */
function render(
  kind: 'effect' | 'transition',
  id: string,
  t: number,
  target: CanvasRenderingContext2D,
): boolean {
  const s = getStage();
  if (!s) return false;
  const { glx } = s;
  const gl = glx.gl;
  const present = glx.program('fx-present', COPY_FS, PRESENT_VS);
  const lumaW = [0.2126, 0.7152, 0.0722] as const;
  try {
    if (kind === 'effect') {
      const def = getEffectDef(id);
      if (!def) return false;
      const params = resolveParams(def.params, defaultParams(def.params));
      const out = runEffect(
        glx,
        def,
        params,
        { tex: s.a, width: W, height: H },
        { px: (H / 1080) * 4, time: t * 2, frame: Math.floor(t * 48), seed: 0.37, lumaW },
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0.07, 0.07, 0.08, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      glx.pass(present, null, { u_tex: out ? out.tex : s.a, u_opacity: 1 }, true);
      glx.release(out);
    } else {
      const def = getTransitionDef(id);
      const program = def ? transitionProgram(glx, def) : null;
      if (!def || !program) return false;
      const params = resolveParams(def.params, defaultParams(def.params));
      const u: Record<string, number | number[] | WebGLTexture | readonly number[]> = {};
      for (const k in params) u[`u_${k}`] = params[k];
      const rt = glx.acquire(W, H);
      glx.pass(program, rt, {
        ...u,
        u_a: s.a,
        u_b: s.b,
        u_progress: easeProgress(def.ease, t),
        u_resolution: [W, H],
        u_texel: [1 / W, 1 / H],
        u_px: (H / 1080) * 4,
        u_aspect: W / H,
        u_seed: 0.37,
        u_lumaW: lumaW,
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      glx.pass(present, null, { u_tex: rt.tex, u_opacity: 1 });
      glx.release(rt);
    }
    target.drawImage(s.canvas as CanvasImageSource, 0, 0);
    return true;
  } catch {
    return false;
  }
}

const stills = new Map<string, ImageBitmap | 'failed'>();

export function FxThumb({ kind, id }: { kind: 'effect' | 'transition'; id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);

  // Resting state: a cached still.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || hover) return;
    const ctx = canvas.getContext('2d')!;
    const key = `${kind}:${id}`;
    const cached = stills.get(key);
    if (cached && cached !== 'failed') {
      ctx.drawImage(cached, 0, 0);
      return;
    }
    if (cached === 'failed') return;
    // Stagger first-time renders so opening the panel never janks.
    const handle = setTimeout(
      () => {
        if (render(kind, id, kind === 'transition' ? 0.5 : 0.3, ctx)) {
          void createImageBitmap(canvas).then((bmp) => stills.set(key, bmp));
        } else stills.set(key, 'failed');
      },
      20 + Math.random() * 180,
    );
    return () => clearTimeout(handle);
  }, [kind, id, hover]);

  // Hover: play it.
  useEffect(() => {
    if (!hover) return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      const s = (performance.now() - t0) / 1000;
      const t = kind === 'transition' ? Math.min(1, Math.max(0, ((s % 2.2) - 0.3) / 1.4)) : (s % 4) / 4;
      render(kind, id, t, ctx);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hover, kind, id]);

  return (
    <canvas
      ref={ref}
      width={W}
      height={H}
      className="fx__thumb"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    />
  );
}
