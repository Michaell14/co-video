import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  clipGainAt,
  cutTransitionWindow,
  gainToDb,
  makeTransition,
  resolveFrame,
  gamutMatrix,
  mulVec3,
  nitsToPq,
  pqToNits,
  hlgToScene,
  sceneToHlg,
  srgbToLinear,
  linearToSrgb,
  lumaWeights,
  parseSubtitles,
  toSrt,
  resolveInputSpace,
  EFFECTS,
  TRANSITIONS,
  resolveParams,
  defaultParams,
} from '../src';
import { addClip, fixture } from './helpers';

describe('resolveFrame', () => {
  it('orders layers bottom to top and skips hidden tracks / disabled clips', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 100);
    p = a.p;
    const b = addClip(p, f.v2.id, 50, 100);
    p = b.p;
    expect(resolveFrame(p, 10).layers).toHaveLength(1);
    const both = resolveFrame(p, 60).layers;
    expect(both.map((l) => (l.kind === 'clip' ? l.layer.clip.id : ''))).toEqual([a.clip.id, b.clip.id]);
    expect(resolveFrame(p, 100).layers).toHaveLength(1);
    expect(resolveFrame(p, 500).layers).toHaveLength(0);

    const hidden = applyEdits(p, [{ op: 'updateTrack', id: f.v2.id, patch: { hidden: true } }]);
    expect(resolveFrame(hidden, 60).layers).toHaveLength(1);
    const disabled = applyEdits(p, [{ op: 'updateClip', id: a.clip.id, patch: { enabled: false } }]);
    expect(resolveFrame(disabled, 10).layers).toHaveLength(0);
  });

  it('computes source time with speed, offset and reverse', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 100, 60, { sourceIn: 2, speed: 2 });
    const l = resolveFrame(a.p, 115).layers[0];
    expect(l.kind === 'clip' && l.layer.sourceTime).toBeCloseTo(2 + (15 / 30) * 2);
    const r = addClip(f.p, f.v1.id, 0, 30, { sourceIn: 1, reverse: true });
    const first = resolveFrame(r.p, 0).layers[0];
    const last = resolveFrame(r.p, 29).layers[0];
    expect(first.kind === 'clip' && first.layer.sourceTime).toBeCloseTo(1 + 29 / 30);
    expect(last.kind === 'clip' && last.layer.sourceTime).toBeCloseTo(1);
  });

  it('centres a two-sided transition on the cut using handles', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 100, { sourceIn: 0 });
    p = a.p;
    const b = addClip(p, f.v1.id, 100, 100, { sourceIn: 10, transIn: makeTransition('crossDissolve', 20) });
    p = b.p;
    expect(cutTransitionWindow(p.clips[a.clip.id], p.clips[b.clip.id])).toEqual({ duration: 20, before: 10 });
    expect(resolveFrame(p, 89).layers[0].kind).toBe('clip');
    expect(resolveFrame(p, 110).layers[0].kind).toBe('clip');
    const start = resolveFrame(p, 90).layers[0];
    const mid = resolveFrame(p, 100).layers[0];
    const end = resolveFrame(p, 109).layers[0];
    if (start.kind !== 'transition' || mid.kind !== 'transition' || end.kind !== 'transition') throw new Error('expected transitions');
    expect(start.progress).toBeGreaterThan(0);
    expect(start.progress).toBeLessThan(0.1);
    expect(mid.progress).toBeCloseTo(11 / 21);
    expect(end.progress).toBeLessThan(1);
    expect(end.progress).toBeGreaterThan(0.9);
    // Incoming clip is showing media from before its in point (the handle), outgoing from past its out point.
    expect(start.b!.localFrame).toBe(-10);
    expect(start.b!.sourceTime).toBeCloseTo(10 - 10 / 30);
    expect(end.a!.localFrame).toBe(109);
    expect(end.a!.sourceTime).toBeCloseTo(109 / 30);
  });

  it('uses one-sided transitions next to gaps', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 50, 100, {
      transIn: makeTransition('crossDissolve', 10),
      transOut: makeTransition('dipToBlack', 10),
    });
    const head = resolveFrame(a.p, 50).layers[0];
    const body = resolveFrame(a.p, 100).layers[0];
    const tail = resolveFrame(a.p, 149).layers[0];
    expect(head.kind === 'transition' && head.a === null && head.b !== null).toBe(true);
    expect(body.kind).toBe('clip');
    expect(tail.kind === 'transition' && tail.a !== null && tail.b === null).toBe(true);
  });

  it('evaluates animated properties', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 0, 100, {
      keyframes: {
        x: [
          { t: 0, v: 0, e: 'linear' },
          { t: 100, v: 1, e: 'linear' },
        ],
      },
    });
    const l = resolveFrame(a.p, 25).layers[0];
    expect(l.kind === 'clip' && l.layer.v.x).toBeCloseTo(0.25);
  });
});

describe('audio gain', () => {
  it('applies volume and equal-power fades', () => {
    const f = fixture();
    const { clip } = addClip(f.p, f.v1.id, 0, 100, { volume: -6, fadeIn: 10, fadeOut: 20 });
    expect(clipGainAt(clip, 0)).toBe(0);
    expect(gainToDb(clipGainAt(clip, 50))).toBeCloseTo(-6);
    expect(clipGainAt(clip, 5)).toBeCloseTo(clipGainAt(clip, 50) * Math.SQRT1_2);
    expect(clipGainAt(clip, 90)).toBeCloseTo(clipGainAt(clip, 50) * Math.SQRT1_2);
    expect(clipGainAt({ ...clip, audioMuted: true }, 50)).toBe(0);
  });
});

describe('colour science', () => {
  it('matches the published Rec.709 → Rec.2020 matrix', () => {
    const m = gamutMatrix('rec709', 'rec2020');
    const ref = [0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0114, 0.0164, 0.088, 0.8956];
    m.forEach((v, i) => expect(v).toBeCloseTo(ref[i], 3));
    // White stays white.
    const w = mulVec3(m, [1, 1, 1]);
    w.forEach((v) => expect(v).toBeCloseTo(1, 5));
  });

  it('has the standard luma weights', () => {
    const [r, g, b] = lumaWeights('rec709');
    expect(r).toBeCloseTo(0.2126, 3);
    expect(g).toBeCloseTo(0.7152, 3);
    expect(b).toBeCloseTo(0.0722, 3);
    expect(lumaWeights('rec2020')[0]).toBeCloseTo(0.2627, 3);
  });

  it('round-trips transfer functions', () => {
    for (const v of [0, 0.001, 0.02, 0.18, 0.5, 1, 4]) {
      expect(srgbToLinear(linearToSrgb(v))).toBeCloseTo(v, 6);
    }
    for (const nits of [0.01, 1, 100, 203, 1000, 4000, 10000]) {
      expect(pqToNits(nitsToPq(nits)) / nits).toBeCloseTo(1, 4);
    }
    // Reference PQ points.
    expect(nitsToPq(100)).toBeCloseTo(0.5081, 3);
    expect(nitsToPq(1000)).toBeCloseTo(0.7518, 3);
    for (const s of [0.001, 0.05, 1 / 12, 0.3, 1]) expect(hlgToScene(sceneToHlg(s))).toBeCloseTo(s, 6);
    expect(sceneToHlg(1)).toBeCloseTo(1, 3);
  });

  it('detects input colour spaces from metadata', () => {
    expect(resolveInputSpace({ inputColorSpace: 'auto', color: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false } })).toBe('rec2020-pq');
    expect(resolveInputSpace({ inputColorSpace: 'auto', color: { primaries: 'bt2020', transfer: 'hlg', matrix: null, fullRange: null } })).toBe('rec2020-hlg');
    expect(resolveInputSpace({ inputColorSpace: 'auto', color: null })).toBe('rec709');
    expect(resolveInputSpace({ inputColorSpace: 'slog3', color: null })).toBe('slog3');
  });
});

describe('libraries', () => {
  it('has unique ids and resolvable defaults for every effect and transition', () => {
    const ids = new Set<string>();
    for (const e of [...EFFECTS, ...TRANSITIONS]) {
      expect(ids.has(e.id), e.id).toBe(false);
      ids.add(e.id);
      const resolved = resolveParams(e.params, defaultParams(e.params));
      for (const d of e.params) {
        const v = resolved[d.key];
        expect(v, `${e.id}.${d.key}`).toBeDefined();
        if (Array.isArray(v)) v.forEach((n) => expect(Number.isFinite(n)).toBe(true));
        else expect(Number.isFinite(v)).toBe(true);
      }
    }
    expect(EFFECTS.length).toBeGreaterThanOrEqual(40);
    expect(TRANSITIONS.length).toBeGreaterThanOrEqual(20);
  });
});

describe('subtitles', () => {
  it('parses SRT and VTT and round-trips', () => {
    const srt = `1\n00:00:01,000 --> 00:00:02,500\nHello <i>there</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nLine one\nLine two\n`;
    const cues = parseSubtitles(srt);
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: 'Hello there' },
      { start: 3, end: 4, text: 'Line one\nLine two' },
    ]);
    expect(parseSubtitles(toSrt(cues))).toEqual(cues);
    const vtt = `WEBVTT\n\n00:01.000 --> 00:02.000\nShort form\n`;
    expect(parseSubtitles(vtt)).toEqual([{ start: 1, end: 2, text: 'Short form' }]);
  });
});
