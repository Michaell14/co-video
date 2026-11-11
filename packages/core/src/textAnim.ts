/**
 * Text (and generator) entrance / exit animation presets.
 *
 * A preset maps a progress value (0 = fully hidden, 1 = fully settled) to a set of modifiers that the
 * renderer layers on top of the clip's own transform.
 */
import type { Clip } from './types';

export interface AnimModifiers {
  /** Multiplies clip opacity. */
  opacity: number;
  /** Added to position, in fractions of the frame. */
  dx: number;
  dy: number;
  /** Multiplies scale. */
  scale: number;
  /** Added to rotation, degrees. */
  rotation: number;
  /** Fraction of characters visible (typewriter). */
  chars: number;
  /** Fraction of the box revealed left → right. */
  wipe: number;
  /** Extra blur in 1080p-reference pixels. */
  blur: number;
}

export const IDENTITY_ANIM: AnimModifiers = {
  opacity: 1,
  dx: 0,
  dy: 0,
  scale: 1,
  rotation: 0,
  chars: 1,
  wipe: 1,
  blur: 0,
};

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export interface TextAnimDef {
  id: string;
  name: string;
  apply: (p: number) => Partial<AnimModifiers>;
}

export const TEXT_ANIMATIONS: TextAnimDef[] = [
  { id: 'none', name: 'None', apply: () => ({}) },
  { id: 'fade', name: 'Fade', apply: (p) => ({ opacity: p }) },
  {
    id: 'slideUp',
    name: 'Slide up',
    apply: (p) => ({ opacity: Math.min(1, p * 2), dy: (1 - easeOutCubic(p)) * 0.08 }),
  },
  {
    id: 'slideDown',
    name: 'Slide down',
    apply: (p) => ({ opacity: Math.min(1, p * 2), dy: -(1 - easeOutCubic(p)) * 0.08 }),
  },
  {
    id: 'slideLeft',
    name: 'Slide left',
    apply: (p) => ({ opacity: Math.min(1, p * 2), dx: (1 - easeOutCubic(p)) * 0.08 }),
  },
  {
    id: 'slideRight',
    name: 'Slide right',
    apply: (p) => ({ opacity: Math.min(1, p * 2), dx: -(1 - easeOutCubic(p)) * 0.08 }),
  },
  {
    id: 'zoomIn',
    name: 'Zoom in',
    apply: (p) => ({ opacity: Math.min(1, p * 2), scale: 0.6 + 0.4 * easeOutCubic(p) }),
  },
  {
    id: 'zoomOut',
    name: 'Zoom out',
    apply: (p) => ({ opacity: Math.min(1, p * 2), scale: 1.5 - 0.5 * easeOutCubic(p) }),
  },
  {
    id: 'pop',
    name: 'Pop',
    apply: (p) => ({ opacity: Math.min(1, p * 3), scale: Math.max(0, easeOutBack(p)) }),
  },
  {
    id: 'blur',
    name: 'Blur in',
    apply: (p) => ({ opacity: p, blur: (1 - easeOutCubic(p)) * 40 }),
  },
  { id: 'typewriter', name: 'Typewriter', apply: (p) => ({ chars: p }) },
  { id: 'wipe', name: 'Wipe', apply: (p) => ({ wipe: easeOutCubic(p) }) },
  {
    id: 'spin',
    name: 'Spin',
    apply: (p) => ({ opacity: Math.min(1, p * 2), rotation: (1 - easeOutCubic(p)) * -90, scale: 0.5 + 0.5 * easeOutCubic(p) }),
  },
  {
    id: 'drop',
    name: 'Drop',
    apply: (p) => {
      // A single damped bounce.
      const t = p;
      const y = t < 0.6 ? 1 - Math.pow(t / 0.6, 2) : 0.12 * Math.sin(((t - 0.6) / 0.4) * Math.PI) * (1 - t);
      return { opacity: Math.min(1, p * 4), dy: -y * (t < 0.6 ? 0.25 : 1) };
    },
  },
];

const INDEX = new Map(TEXT_ANIMATIONS.map((a) => [a.id, a]));

/** Combined in/out animation modifiers for a clip at a local frame. */
export function textAnimAt(clip: Clip, localFrame: number): AnimModifiers {
  const t = clip.text;
  if (!t) return IDENTITY_ANIM;
  let out: AnimModifiers = IDENTITY_ANIM;
  const merge = (m: Partial<AnimModifiers>) => {
    out = {
      opacity: out.opacity * (m.opacity ?? 1),
      dx: out.dx + (m.dx ?? 0),
      dy: out.dy + (m.dy ?? 0),
      scale: out.scale * (m.scale ?? 1),
      rotation: out.rotation + (m.rotation ?? 0),
      chars: Math.min(out.chars, m.chars ?? 1),
      wipe: Math.min(out.wipe, m.wipe ?? 1),
      blur: out.blur + (m.blur ?? 0),
    };
  };
  const inDef = INDEX.get(t.animIn.type);
  if (inDef && inDef.id !== 'none' && t.animIn.duration > 0 && localFrame < t.animIn.duration) {
    merge(inDef.apply(Math.max(0, localFrame / t.animIn.duration)));
  }
  const outDef = INDEX.get(t.animOut.type);
  const remaining = clip.duration - localFrame;
  if (outDef && outDef.id !== 'none' && t.animOut.duration > 0 && remaining < t.animOut.duration) {
    merge(outDef.apply(Math.max(0, remaining / t.animOut.duration)));
  }
  return out;
}
