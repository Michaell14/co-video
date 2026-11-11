/**
 * Video scopes, computed from a small display-referred copy of the frame the compositor just drew.
 * The read-back is asynchronous (PBO + fence), so scopes never stall playback.
 */
import { Activity } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { nitsToPq } from '@tandem/core';
import { usePlayer, useProject } from '../../session/hooks';
import { useUI } from '../../state/ui';
import { MenuButton } from '../../ui/core';

type ScopeKind = 'waveform' | 'parade' | 'vectorscope' | 'histogram';

const LABELS: Record<ScopeKind, string> = { waveform: 'Waveform', parade: 'RGB Parade', vectorscope: 'Vectorscope', histogram: 'Histogram' };
const N = 256;

interface Frame {
  data: Uint8Array;
  width: number;
  height: number;
  pq: boolean;
}

/** Accumulate hits into a float buffer and tone them into an RGBA image. */
function toImage(acc: Float32Array, img: ImageData, gain: number): void {
  const out = img.data;
  for (let i = 0, j = 0; i < acc.length; i += 3, j += 4) {
    out[j] = Math.min(255, Math.sqrt(acc[i] * gain) * 255);
    out[j + 1] = Math.min(255, Math.sqrt(acc[i + 1] * gain) * 255);
    out[j + 2] = Math.min(255, Math.sqrt(acc[i + 2] * gain) * 255);
    out[j + 3] = 255;
  }
}

function drawWaveform(f: Frame, img: ImageData, mode: 'luma' | 'parade'): void {
  const acc = new Float32Array(N * N * 3);
  const { data, width, height } = f;
  const cols = mode === 'parade' ? Math.floor(N / 3) : N;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const cx = Math.min(cols - 1, Math.floor((x / width) * cols));
      if (mode === 'luma') {
        const l = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        const p = ((N - 1 - l) * N + cx) * 3;
        acc[p] += 0.55;
        acc[p + 1] += 1;
        acc[p + 2] += 0.6;
      } else {
        acc[((N - 1 - r) * N + cx) * 3] += 1;
        acc[((N - 1 - g) * N + cx + cols) * 3 + 1] += 1;
        acc[((N - 1 - b) * N + cx + cols * 2) * 3 + 2] += 1;
        // A little white in each so dense areas read clearly.
        acc[((N - 1 - r) * N + cx) * 3 + 1] += 0.18;
        acc[((N - 1 - g) * N + cx + cols) * 3] += 0.18;
        acc[((N - 1 - b) * N + cx + cols * 2) * 3 + 1] += 0.3;
      }
    }
  }
  toImage(acc, img, (N / (width * height)) * (mode === 'parade' ? 5 : 9));
}

function drawVectorscope(f: Frame, img: ImageData): void {
  const acc = new Float32Array(N * N * 3);
  const { data, width, height } = f;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const r = data[o] / 255;
    const g = data[o + 1] / 255;
    const b = data[o + 2] / 255;
    const cb = -0.1146 * r - 0.3854 * g + 0.5 * b;
    const cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
    const x = Math.round(N / 2 + cb * (N - 16));
    const y = Math.round(N / 2 - cr * (N - 16));
    if (x < 0 || x >= N || y < 0 || y >= N) continue;
    const p = (y * N + x) * 3;
    acc[p] += 0.35 + r * 0.9;
    acc[p + 1] += 0.35 + g * 0.9;
    acc[p + 2] += 0.35 + b * 0.9;
  }
  toImage(acc, img, (N / (width * height)) * 14);
}

function drawHistogram(f: Frame, ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const bins = [new Uint32Array(N), new Uint32Array(N), new Uint32Array(N)];
  const { data, width, height } = f;
  for (let i = 0; i < width * height; i++) {
    bins[0][data[i * 4]]++;
    bins[1][data[i * 4 + 1]]++;
    bins[2][data[i * 4 + 2]]++;
  }
  let peak = 1;
  // Ignore the extreme bins when scaling so a black border does not flatten everything else.
  for (const b of bins) for (let i = 2; i < N - 2; i++) if (b[i] > peak) peak = b[i];
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  const colors = ['rgba(255,80,80,0.75)', 'rgba(80,220,110,0.75)', 'rgba(90,150,255,0.8)'];
  bins.forEach((b, c) => {
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < N; i++) ctx.lineTo((i / (N - 1)) * w, h - Math.min(1, Math.sqrt(b[i] / peak)) * (h - 4));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = colors[c];
    ctx.fill();
  });
  ctx.globalCompositeOperation = 'source-over';
}

/** Graticule: level lines for waveforms; targets and skin-tone line for the vectorscope. */
function graticule(ctx: CanvasRenderingContext2D, kind: ScopeKind, w: number, h: number, pq: boolean): void {
  ctx.save();
  ctx.font = '500 9px "JetBrains Mono Variable", ui-monospace, monospace';
  ctx.lineWidth = 1;
  if (kind === 'waveform' || kind === 'parade') {
    const marks: [number, string][] = pq
      ? [1, 10, 100, 203, 1000, 4000, 10000].map((n) => [nitsToPq(n), n >= 1000 ? `${n / 1000}k` : String(n)] as [number, string])
      : [0, 25, 50, 75, 100].map((p) => [p / 100, String(p)] as [number, string]);
    for (const [v, label] of marks) {
      const y = Math.round((1 - v) * (h - 1)) + 0.5;
      ctx.strokeStyle = v === 1 || v === 0 || label === '203' ? 'rgba(198,248,79,0.28)' : 'rgba(255,255,255,0.1)';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(200,200,210,0.6)';
      ctx.fillText(label, 3, Math.min(h - 3, Math.max(9, y - 2)));
    }
    if (pq) {
      ctx.fillStyle = 'rgba(200,200,210,0.45)';
      ctx.fillText('nits', w - 24, 10);
    }
  } else if (kind === 'vectorscope') {
    const cx = w / 2;
    const cy = h / 2;
    const R = (Math.min(w, h) / 2) * ((N - 16) / N);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    for (const k of [0.25, 0.5]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * k * 2 * 0.5 * 2 * 0.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.5, cy);
    ctx.lineTo(cx + R * 0.5, cy);
    ctx.moveTo(cx, cy - R * 0.5);
    ctx.lineTo(cx, cy + R * 0.5);
    ctx.stroke();
    // 75% colour-bar targets.
    const targets: [string, number, number, number][] = [
      ['R', 0.75, 0, 0],
      ['Yl', 0.75, 0.75, 0],
      ['G', 0, 0.75, 0],
      ['Cy', 0, 0.75, 0.75],
      ['B', 0, 0, 0.75],
      ['Mg', 0.75, 0, 0.75],
    ];
    for (const [name, r, g, b] of targets) {
      const cb = -0.1146 * r - 0.3854 * g + 0.5 * b;
      const cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
      const x = cx + cb * R * 2;
      const y = cy - cr * R * 2;
      ctx.strokeStyle = `rgba(${r * 340}, ${g * 340}, ${b * 340}, 0.9)`;
      ctx.strokeRect(Math.round(x) - 4.5, Math.round(y) - 4.5, 9, 9);
      ctx.fillStyle = 'rgba(200,200,210,0.6)';
      ctx.fillText(name, x + 7, y + 3);
    }
    // Skin-tone line (the "I" axis, ~123°).
    const a = (123 * Math.PI) / 180;
    ctx.strokeStyle = 'rgba(255,190,150,0.5)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy - Math.sin(a) * R);
    ctx.stroke();
  }
  ctx.restore();
}

function Scope({ kind, frameRef, version }: { kind: ScopeKind; frameRef: React.RefObject<Frame | null>; version: React.RefObject<number> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratch = useRef<{ canvas: HTMLCanvasElement; img: ImageData } | null>(null);
  useEffect(() => {
    let raf = 0;
    let seen = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const f = frameRef.current;
      const canvas = canvasRef.current;
      if (!f || !canvas || version.current === seen) return;
      seen = version.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(10, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(10, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      if (kind === 'histogram') {
        drawHistogram(f, ctx, w, h);
        return;
      }
      if (!scratch.current) {
        const c = document.createElement('canvas');
        c.width = N;
        c.height = N;
        scratch.current = { canvas: c, img: new ImageData(N, N) };
      }
      const s = scratch.current;
      if (kind === 'vectorscope') drawVectorscope(f, s.img);
      else drawWaveform(f, s.img, kind === 'parade' ? 'parade' : 'luma');
      s.canvas.getContext('2d')!.putImageData(s.img, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      if (kind === 'vectorscope') {
        const side = Math.min(w, h);
        ctx.drawImage(s.canvas, (w - side) / 2, (h - side) / 2, side, side);
      } else ctx.drawImage(s.canvas, 0, 0, w, h);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      graticule(ctx, kind, w / dpr, h / dpr, f.pq);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [kind, frameRef, version]);
  return (
    <div className="scope" data-kind={kind}>
      <div className="scope__label">{LABELS[kind]}</div>
      <canvas ref={canvasRef} />
    </div>
  );
}

export function Scopes() {
  const player = usePlayer();
  const enabled = useUI((s) => s.scopes);
  const set = useUI((s) => s.set);
  const hdr = useProject((p) => p.settings.colorMode !== 'sdr');
  const frameRef = useRef<Frame | null>(null);
  const version = useRef(0);

  useEffect(() => {
    if (!player) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState === 'visible') {
        const f = await player.readScope(256).catch(() => null);
        if (f && !stop) {
          frameRef.current = f;
          version.current++;
        }
      }
      // ~12 Hz while playing; a slower heartbeat when idle still catches grade tweaks immediately
      // because every edit re-renders the frame.
      timer = setTimeout(tick, player.getState().playing ? 80 : 120);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [player]);

  const kinds = (Object.keys(LABELS) as ScopeKind[]).filter((k) => enabled[k]);
  return (
    <>
      <div className="panel__head">
        <Activity size={14} style={{ marginLeft: 8, color: 'var(--fg-3)' }} />
        <div className="panel__title">Scopes</div>
        {hdr && <span className="badge badge--amber">PQ nits</span>}
        <span className="panel__spacer" />
        <MenuButton
          className="btn btn--ghost btn--sm"
          label="Choose scopes"
          align="end"
          items={(Object.keys(LABELS) as ScopeKind[]).map((k) => ({ label: LABELS[k], checked: enabled[k], onSelect: () => set({ scopes: { ...enabled, [k]: !enabled[k] } }) }))}
        >
          {kinds.length} shown
        </MenuButton>
      </div>
      <div className="scopes">
        {kinds.length === 0 ? (
          <div className="empty">
            <Activity />
            <b>No scopes shown</b>
            Pick some from the menu above.
          </div>
        ) : (
          kinds.map((k) => <Scope key={k} kind={k} frameRef={frameRef} version={version} />)
        )}
      </div>
    </>
  );
}
