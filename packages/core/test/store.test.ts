import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ASSET_DEFAULTS,
  CLIP_DEFAULTS,
  DEFAULT_COMPRESSOR,
  DEFAULT_EQ,
  DEFAULT_GRADE,
  DEFAULT_MASK,
  DEFAULT_SHAPE,
  DEFAULT_TEXT,
  ProjectStore,
  ReviewStore,
  addTrack,
  baseValue,
  changeFrameRate,
  clipGainAt,
  clipsUnderFrame,
  displayTracks,
  formatTimecode,
  framesToSeconds,
  gainBreakpoints,
  initials,
  makeClip,
  makeEffect,
  makeTrack,
  makeTransition,
  parseProjectFile,
  removeTrack,
  resolveFrame,
  sequenceEnd,
  serializeProject,
  setSpeed,
  snapPoints,
  splitClips,
  toEdl,
  tracksOf,
  trimRange,
} from '../src';
import type { Asset, Clip, Edit, Project, ProjectSettings, Track } from '../src';
import { connect } from './helpers';

describe('ProjectStore', () => {
  it('initialises a new document once', () => {
    const s = new ProjectStore();
    s.initIfEmpty({ name: 'Demo', width: 3840, height: 2160 });
    expect(s.get().settings.width).toBe(3840);
    expect(tracksOf(s.get()).video).toHaveLength(2);
    expect(tracksOf(s.get()).audio).toHaveLength(2);
    s.initIfEmpty({ name: 'Other' });
    expect(s.get().settings.name).toBe('Demo');
    // Initialisation is not an undo step.
    expect(s.canUndo).toBe(false);
  });

  it('round-trips clips and omits default fields from the document', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const track = tracksOf(s.get()).video[0];
    const clip = makeClip('video', track.id, { start: 10, duration: 50, opacity: 0.5 });
    s.commit([{ op: 'addClip', clip }]);
    expect(s.get().clips[clip.id]).toEqual(clip);
    const stored = (s.doc.getMap('clips').get(clip.id) as Y.Map<unknown>).toJSON();
    expect(stored.opacity).toBe(0.5);
    expect('rotation' in stored).toBe(false);
  });

  it('composes several edits to one entity inside a single commit', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const track = tracksOf(s.get()).video[0];
    const clip = makeClip('video', track.id, { start: 0, duration: 50 });
    s.commit([
      { op: 'addClip', clip },
      { op: 'updateClip', id: clip.id, patch: { start: 25 } },
      { op: 'updateClip', id: clip.id, patch: { opacity: 0.25 } },
    ]);
    expect(s.get().clips[clip.id].start).toBe(25);
    expect(s.get().clips[clip.id].opacity).toBe(0.25);
  });

  it('notifies subscribers once per commit and keeps untouched clips referentially stable', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const track = tracksOf(s.get()).video[0];
    const a = makeClip('video', track.id, { start: 0, duration: 10 });
    const b = makeClip('video', track.id, { start: 10, duration: 10 });
    s.commit([
      { op: 'addClip', clip: a },
      { op: 'addClip', clip: b },
    ]);
    let calls = 0;
    s.subscribe(() => calls++);
    const before = s.get().clips[b.id];
    s.commit([
      { op: 'updateClip', id: a.id, patch: { x: 0.1 } },
      { op: 'updateClip', id: a.id, patch: { y: 0.2 } },
    ]);
    expect(calls).toBe(1);
    expect(s.get().clips[b.id]).toBe(before);
    expect(s.get().clips[a.id].x).toBe(0.1);
  });

  it('undoes and redoes, merging gesture commits into one step', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const track = tracksOf(s.get()).video[0];
    const clip = makeClip('video', track.id, { duration: 10 });
    s.commit([{ op: 'addClip', clip }]);
    s.commit([{ op: 'updateClip', id: clip.id, patch: { x: 0.1 } }]);
    for (const x of [0.2, 0.3, 0.4])
      s.commit([{ op: 'updateClip', id: clip.id, patch: { x } }], { merge: true });
    expect(s.get().clips[clip.id].x).toBe(0.4);
    s.undo();
    expect(s.get().clips[clip.id].x).toBe(0);
    s.undo();
    expect(s.get().clips[clip.id]).toBeUndefined();
    s.redo();
    s.redo();
    expect(s.get().clips[clip.id].x).toBe(0.4);
  });

  it('converges between two peers with per-field merging', () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    expect(tracksOf(b.get()).video).toHaveLength(2);

    const track = tracksOf(a.get()).video[0];
    const clip = makeClip('video', track.id, { duration: 100 });
    a.commit([{ op: 'addClip', clip }]);
    expect(b.get().clips[clip.id]).toEqual(clip);

    // Concurrent edits to different fields of the same clip both survive.
    a.commit([{ op: 'updateClip', id: clip.id, patch: { start: 40 } }]);
    b.commit([
      { op: 'updateClip', id: clip.id, patch: { opacity: 0.3, effects: [makeEffect('gaussianBlur')] } },
    ]);
    for (const s of [a, b]) {
      const c = s.get().clips[clip.id];
      expect(c.start).toBe(40);
      expect(c.opacity).toBe(0.3);
      expect(c.effects).toHaveLength(1);
    }
    expect(a.get().clips).toEqual(b.get().clips);
  });

  it("only undoes the local user's edits", () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    const track = tracksOf(a.get()).video[0];
    const ca = makeClip('video', track.id, { start: 0, duration: 10 });
    const cb = makeClip('video', track.id, { start: 50, duration: 10 });
    a.commit([{ op: 'addClip', clip: ca }]);
    b.commit([{ op: 'addClip', clip: cb }]);
    a.undo();
    expect(a.get().clips[ca.id]).toBeUndefined();
    expect(a.get().clips[cb.id]).toBeDefined();
    expect(b.get().clips[ca.id]).toBeUndefined();
    expect(b.get().clips[cb.id]).toBeDefined();
  });

  it('ignores malformed remote data instead of crashing', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const evil = new Y.Map<unknown>();
    s.doc.transact(() => {
      evil.set('trackId', tracksOf(s.get()).video[0].id);
      evil.set('type', 'video');
      evil.set('start', 'banana');
      evil.set('duration', -50);
      evil.set('speed', 0);
      evil.set('effects', 'not-an-array');
      s.doc.getMap('clips').set('evil', evil);
      s.doc.getMap('clips').set('junk', 42 as never);
    });
    const c = s.get().clips.evil;
    expect(c.start).toBe(0);
    expect(c.duration).toBe(1);
    expect(c.speed).toBe(1);
    expect(c.effects).toEqual([]);
    expect(s.get().clips.junk).toBeUndefined();
  });

  /** Everything the renderer, the timeline and the common edits do with a snapshot. */
  const exercise = (p: Project): void => {
    const end = sequenceEnd(p);
    for (const f of [0, 1, Math.floor(end / 2), end - 1, end]) resolveFrame(p, f);
    snapPoints(p, new Set());
    changeFrameRate(p, 24, 1);
    toEdl(p);
    formatTimecode(end, p.settings);
    for (const c of Object.values(p.clips)) {
      for (const path of Object.keys(c.keyframes)) baseValue(c, path);
      baseValue(c, 'fx:nope:amount');
      clipGainAt(c, 0);
      gainBreakpoints(c);
      trimRange(p, [c.id], 'end', false);
      setSpeed(p, [c.id], 2);
      splitClips(p, [c.id], c.start + 1);
    }
  };

  it('repairs malformed nested clip data so nothing downstream can throw', () => {
    const garbage: unknown[] = [
      null,
      5,
      -1e308,
      'x',
      true,
      [],
      [null],
      [[null]],
      [5, 'a'],
      {},
      { a: null },
      { x: [null] },
      { x: [{ t: 'soon', v: 1 }] },
      { x: 7 },
    ];
    const nested: Record<string, unknown[]> = {
      text: [
        { animIn: null, animOut: 5 },
        { gradient: 5, stroke: null, shadow: 'x', bg: [] },
        { align: 'diagonal', boxWidth: 'wide', size: 'big', content: 7 },
        { animIn: { type: 9, duration: 'long' } },
      ],
      grade: [
        { curves: { m: [null], r: 5, g: [[0, 'a']], b: [[0.5, 0.5]] } },
        { curves: null, lift: 'x', gamma: [1, 2], zones: null, hueSat: [[1, 1], null, [0, 0]] },
        { lutId: {}, lutIntensity: 'full' },
      ],
      shape: [
        { gradient: null, kind: 'blob', sides: 1e9 },
        { sides: -4, w: 'wide' },
      ],
      mask: [{ type: 5, x: 'left' }, { feather: null }],
      effects: [
        [{ id: 'a', type: 'gaussianBlur', enabled: 'yes', params: null }],
        [{ id: 'b', type: 'gaussianBlur', params: { radius: {}, list: [1, null] } }, { id: 5 }, 'x'],
      ],
      keyframes: [
        { x: [{ t: 10, v: 1, e: [9, 9, 9] }, { t: 0, v: 0, e: 'bouncy' }, null, { t: NaN, v: 1 }] },
        { 'fx:a:radius': [{ t: 0, v: 3 }] },
      ],
      transIn: [{ type: 5 }, { type: 'crossDissolve', duration: 'long' }, { type: 'crossDissolve' }],
      transOut: [{ type: 'crossDissolve', duration: -5, params: [null] }],
    };
    const s = new ProjectStore();
    s.initIfEmpty();
    const track = tracksOf(s.get()).video[0];
    const cases: [string, unknown][] = [];
    for (const key of Object.keys(CLIP_DEFAULTS)) for (const g of garbage) cases.push([key, g]);
    for (const [key, list] of Object.entries(nested)) for (const g of list) cases.push([key, g]);
    cases.forEach(([key, value], i) => {
      const m = new Y.Map<unknown>();
      s.doc.transact(() => {
        m.set('trackId', track.id);
        m.set('type', i % 2 ? 'text' : 'video');
        m.set('start', i * 20);
        m.set('duration', 20);
        m.set('text', { ...DEFAULT_TEXT });
        m.set(key, value);
        s.doc.getMap('clips').set(`c${i}`, m);
      });
    });
    const p = s.get();
    expect(Object.keys(p.clips)).toHaveLength(cases.length);
    expect(() => exercise(p)).not.toThrow();

    // The repaired values are well-formed, not merely survivable.
    const byCase = (key: string, n: number): Clip =>
      p.clips[`c${cases.findIndex(([k, v]) => k === key && v === nested[key][n])}`];
    expect(byCase('keyframes', 0).keyframes).toEqual({
      x: [
        { t: 0, v: 0, e: 'linear' },
        { t: 10, v: 1, e: 'linear' },
      ],
    });
    expect(byCase('text', 0).text!.animIn).toEqual(DEFAULT_TEXT.animIn);
    expect(byCase('text', 2).text).toEqual(DEFAULT_TEXT);
    expect(byCase('grade', 0).grade!.curves).toEqual(DEFAULT_GRADE.curves);
    expect(byCase('grade', 1).grade!.hueSat).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(byCase('grade', 1).grade!.zones).toEqual(DEFAULT_GRADE.zones);
    expect(byCase('shape', 0).shape).toEqual({ ...DEFAULT_SHAPE, sides: 64 });
    expect(byCase('mask', 0).mask).toEqual(DEFAULT_MASK);
    expect(byCase('effects', 1).effects).toEqual([
      { id: 'b', type: 'gaussianBlur', enabled: true, params: {} },
    ]);
    expect(byCase('transIn', 1).transIn).toBeNull();
    expect(byCase('transOut', 0).transOut).toEqual({ type: 'crossDissolve', duration: 1, params: {} });

    // The same repairs apply to an imported project file.
    const file = JSON.parse(serializeProject(p));
    cases.forEach(([key, value], i) => (file.project.clips[`c${i}`][key] = value));
    const loaded = parseProjectFile(JSON.stringify(file))!;
    expect(Object.keys(loaded.clips)).toHaveLength(cases.length);
    expect(() => exercise(loaded)).not.toThrow();
    expect(loaded.clips).toEqual(p.clips);
  });

  /** A clip, a track and an asset in which no field has its default value. */
  const everyFieldSet = (trackId: string) => {
    const fx = makeEffect('gaussianBlur');
    const clip = makeClip('text', trackId, {
      assetId: 'asset9',
      start: 12,
      duration: 90,
      sourceIn: 1.5,
      speed: 2,
      reverse: true,
      freeze: true,
      name: 'Title',
      label: '#ef4444',
      enabled: false,
      linkId: 'link1',
      x: 0.1,
      y: -0.2,
      scaleX: 1.5,
      scaleY: 0.5,
      rotation: 30,
      anchorX: 0.25,
      anchorY: 0.75,
      opacity: 0.8,
      blend: 'soft-light',
      fit: 'cover',
      flipH: true,
      flipV: true,
      cropL: 0.1,
      cropT: 0.2,
      cropR: 0.3,
      cropB: 0.4,
      volume: -6,
      pan: 0.5,
      fadeIn: 5,
      fadeOut: 7,
      audioMuted: true,
      effects: [fx, { ...makeEffect('gaussianBlur'), enabled: false }],
      grade: {
        ...DEFAULT_GRADE,
        lift: [0.1, 0, -0.1, 0.02],
        curves: {
          ...DEFAULT_GRADE.curves,
          m: [
            [0, 0.05],
            [0.5, 0.6],
            [1, 0.95],
          ],
        },
        zones: { ...DEFAULT_GRADE.zones, mid: 0.5 },
        lutId: 'lut1',
      },
      mask: { ...DEFAULT_MASK, type: 'rect', invert: true },
      keyframes: {
        x: [
          { t: 0, v: 0, e: 'hold' },
          { t: 30, v: 0.2, e: [0.2, 0, 0, 1.4] },
        ],
        [`fx:${fx.id}:radius`]: [{ t: 10, v: 12, e: 'easeInOut' }],
        opacity: [],
      },
      transIn: makeTransition('crossDissolve', 12),
      transOut: makeTransition('dipToBlack', 8),
      text: {
        ...DEFAULT_TEXT,
        content: 'Hello',
        align: 'left',
        boxWidth: 0.5,
        stroke: { enabled: true, color: '#112233', width: 0.1 },
        animIn: { type: 'slideUp', duration: 20 },
      },
      shape: { ...DEFAULT_SHAPE, kind: 'star', sides: 7 },
    });
    const track: Track = {
      ...makeTrack('audio', 3, 'Dialogue'),
      muted: true,
      solo: true,
      locked: true,
      hidden: true,
      height: 80,
      volume: -3,
      pan: -0.5,
      eq: { ...DEFAULT_EQ, enabled: true, mid: 4 },
      compressor: { ...DEFAULT_COMPRESSOR, enabled: true, ratio: 6 },
    };
    const asset: Asset = {
      id: 'asset9',
      name: 'shot.mov',
      kind: 'video',
      size: 1024,
      mime: 'video/quicktime',
      duration: 12.5,
      width: 3840,
      height: 2160,
      fps: 23.976,
      rotation: 90,
      hasVideo: true,
      hasAudio: true,
      audioChannels: 2,
      audioSampleRate: 48000,
      videoCodec: 'hvc1',
      audioCodec: 'mp4a',
      color: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false },
      hdr: true,
      inputColorSpace: 'rec2020-pq',
      folderId: 'folder1',
      createdAt: 1700000000000,
      createdBy: 'u1',
      thumb: 'data:image/webp;base64,AAAA',
      uploaded: true,
    };
    return { clip, track, asset };
  };

  it('keeps every well-formed field exactly as written', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const { clip, track, asset } = everyFieldSet(tracksOf(s.get()).video[0].id);
    // A field added to the model has to be added above too, or this test cannot vouch for it.
    const unset = (entity: object, defaults: object): string[] =>
      Object.entries(defaults)
        .filter(([key, d]) => JSON.stringify((entity as Record<string, unknown>)[key]) === JSON.stringify(d))
        .map(([key]) => key);
    expect(unset(clip, CLIP_DEFAULTS)).toEqual([]);
    expect(unset(asset, ASSET_DEFAULTS)).toEqual([]);
    expect(unset(track, makeTrack('video', 0))).toEqual([]);

    const marker = { id: 'm1', frame: 48, name: 'Beat', color: '#ef4444', note: 'On the snare' };
    const folder = { id: 'folder1', name: 'Day 1', parentId: 'root' };
    const settings: ProjectSettings = {
      name: 'Feature',
      width: 4096,
      height: 1716,
      fpsNum: 24000,
      fpsDen: 1001,
      sampleRate: 96000,
      background: '#101010',
      colorMode: 'hdr-pq',
      toneMap: 'bt2390',
      peakNits: 4000,
      refWhiteNits: 100,
    };
    s.commit([
      { op: 'settings', patch: settings },
      { op: 'addAsset', asset },
      { op: 'addTrack', track },
      { op: 'addClip', clip },
      { op: 'setMarker', marker },
      { op: 'addFolder', folder },
    ]);
    const p = s.get();
    expect(p.settings).toEqual(settings);
    expect(p.assets[asset.id]).toEqual(asset);
    expect(p.tracks[track.id]).toEqual(track);
    expect(p.clips[clip.id]).toEqual(clip);
    expect(p.markers.m1).toEqual(marker);
    expect(p.folders.folder1).toEqual(folder);
    expect(parseProjectFile(serializeProject(p))).toEqual(p);
    // A second store on the same document reads the same thing.
    expect(new ProjectStore(s.doc).get()).toEqual(p);
  });

  it('keeps nested values referentially stable when other fields of the clip change', () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    const { clip } = everyFieldSet(tracksOf(a.get()).video[0].id);
    a.commit([{ op: 'addClip', clip }]);
    const nested = ['effects', 'grade', 'mask', 'keyframes', 'transIn', 'transOut', 'text', 'shape'] as const;
    for (const s of [a, b]) {
      const before = s.get().clips[clip.id];
      a.commit([{ op: 'updateClip', id: clip.id, patch: { opacity: 0.4, start: 40 } }]);
      const after = s.get().clips[clip.id];
      expect(after).not.toBe(before);
      expect(after.opacity).toBe(0.4);
      // The renderer keys its curve and text caches on these.
      for (const key of nested) expect(after[key], key).toBe(before[key]);
      expect(after.grade!.curves).toBe(before.grade!.curves);
      a.commit([{ op: 'updateClip', id: clip.id, patch: { opacity: 0.8, start: 12 } }]);
    }
    // Replacing one nested value changes that one only.
    const before = b.get().clips[clip.id];
    a.commit([{ op: 'updateClip', id: clip.id, patch: { mask: { ...DEFAULT_MASK, feather: 0.3 } } }]);
    const after = b.get().clips[clip.id];
    expect(after.mask).not.toBe(before.mask);
    expect(after.mask!.feather).toBe(0.3);
    for (const key of nested) if (key !== 'mask') expect(after[key], key).toBe(before[key]);
  });

  it('repairs malformed markers, folders, tracks and settings', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    s.commit([
      { op: 'setMarker', marker: { id: 'good', frame: 48, name: 'Beat', color: '#fff', note: 'n' } },
    ]);
    const good = s.get().markers.good;
    s.doc.transact(() => {
      const markers = s.doc.getMap('markers');
      markers.set('null', null);
      markers.set('text', 'marker');
      markers.set('noFrame', { name: 'x' });
      markers.set('loose', { frame: 12.4, name: 5, color: null });
      const folders = s.doc.getMap('folders');
      folders.set('null', null);
      folders.set('loose', { name: 9, parentId: 3 });
      const t = new Y.Map<unknown>();
      t.set('kind', 'audio');
      t.set('eq', { enabled: 'yes', low: 'boomy' });
      t.set('compressor', [1, 2]);
      t.set('order', 'first');
      s.doc.getMap('tracks').set('t', t);
      const settings = s.doc.getMap('settings');
      settings.set('fpsNum', 0);
      settings.set('width', -5);
      settings.set('height', 1e9);
      settings.set('sampleRate', 3);
      settings.set('colorMode', 'technicolor');
      settings.set('toneMap', null);
    });
    const p = s.get();
    expect(Object.keys(p.markers).sort()).toEqual(['good', 'loose']);
    expect(p.markers.loose).toEqual({ id: 'loose', frame: 12, name: '', color: '#f59e0b', note: '' });
    // Markers nobody touched keep their identity.
    expect(p.markers.good).toBe(good);
    expect(p.folders).toEqual({ loose: { id: 'loose', name: '', parentId: null } });
    expect(p.tracks.t.eq).toEqual({
      enabled: false,
      low: 0,
      mid: 0,
      high: 0,
      lowFreq: 120,
      midFreq: 1200,
      highFreq: 8000,
    });
    expect(p.tracks.t.compressor).toBeNull();
    expect(p.tracks.t.order).toBe(0);
    expect(p.settings).toMatchObject({
      fpsNum: 30,
      fpsDen: 1,
      width: 16,
      height: 16384,
      sampleRate: 8000,
      colorMode: 'sdr',
      toneMap: 'none',
    });
    expect(formatTimecode(90, p.settings)).toBe('00:00:03:00');
    expect(() => exercise(p)).not.toThrow();

    const file = JSON.parse(serializeProject(p));
    file.project.markers = { a: null, b: { frame: 3 } };
    file.project.folders = 'none';
    file.project.settings = { fpsNum: 30000, fpsDen: 0, width: 'wide' };
    const loaded = parseProjectFile(JSON.stringify(file))!;
    expect(Object.keys(loaded.markers)).toEqual(['b']);
    expect(loaded.folders).toEqual({});
    expect(loaded.settings).toMatchObject({ fpsNum: 30, fpsDen: 1, width: 1920 });
    expect(() => exercise(loaded)).not.toThrow();
  });

  it('never lets an entity id replace the prototype of a snapshot record', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const track = tracksOf(s.get()).video[0];
    s.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('trackId', track.id);
      m.set('type', 'video');
      s.doc.getMap('clips').set('__proto__', m);
      const onProto = new Y.Map<unknown>();
      onProto.set('trackId', 'constructor');
      onProto.set('type', 'video');
      s.doc.getMap('clips').set('c', onProto);
      s.doc.getMap('markers').set('__proto__', { frame: 5 });
    });
    const p = s.get();
    expect(Object.keys(p.clips)).toEqual([]);
    expect(Object.getPrototypeOf(p.clips)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(p.markers)).toBe(Object.prototype);
    const file = `{"format":"tandem-project","project":{"tracks":{"__proto__":{"kind":"video"}}}}`;
    const loaded = parseProjectFile(file)!;
    expect(Object.getPrototypeOf(loaded.tracks)).toBe(Object.prototype);
    expect(Object.keys(loaded.tracks)).toEqual([]);
  });

  it('only accepts inline images as asset posters', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const put = (id: string, thumb: unknown) => {
      const m = new Y.Map<unknown>();
      m.set('kind', 'video');
      m.set('name', id);
      m.set('thumb', thumb);
      s.doc.getMap('assets').set(id, m);
    };
    s.doc.transact(() => {
      put('ok', 'data:image/jpeg;base64,AAAA');
      put('remote', 'https://tracker.example/pixel.png');
      put('script', 'javascript:alert(1)');
      put('svg', 'data:image/svg+xml;base64,AAAA');
    });
    const a = s.get().assets;
    expect(a.ok.thumb).toBe('data:image/jpeg;base64,AAAA');
    expect(a.remote.thumb).toBeNull();
    expect(a.script.thumb).toBeNull();
    expect(a.svg.thumb).toBeNull();
  });

  describe('colours', () => {
    const remote = 'url(https://tracker.example/pixel.png)';
    const hostile: unknown[] = [
      remote,
      `#fff url(https://tracker.example/pixel.png)`,
      `#${'f'.repeat(1_000_000)}`,
      'red',
      'rgb(255, 0, 0)',
      'var(--accent)',
      '#12345',
      '#ggg',
      '',
      ' #ffffff',
      '#ffffff\n',
      0xffffff,
      ['#ffffff'],
      { r: 1 },
    ];

    /** A store whose document holds `fields` as a clip called `c`, written the way a peer could. */
    const withClip = (type: string, fields: Record<string, unknown>): ProjectStore => {
      const s = new ProjectStore();
      s.initIfEmpty();
      const m = new Y.Map<unknown>();
      s.doc.transact(() => {
        m.set('trackId', tracksOf(s.get()).video[0].id);
        m.set('type', type);
        for (const [key, value] of Object.entries(fields)) m.set(key, value);
        s.doc.getMap('clips').set('c', m);
      });
      return s;
    };

    it('reads a clip label, a marker colour and the background as hex or not at all', () => {
      for (const bad of hostile) {
        const s = withClip('video', { label: bad });
        s.doc.transact(() => {
          s.doc.getMap('markers').set('m', { frame: 10, name: 'Beat', color: bad, note: '' });
          s.doc.getMap('settings').set('background', bad);
        });
        const p = s.get();
        expect(p.clips.c.label, String(bad).slice(0, 40)).toBeNull();
        expect(p.markers.m.color).toBe('#f59e0b');
        expect(p.settings.background).toBe('#000000');
        expect(parseProjectFile(serializeProject(p))).toEqual(p);
      }
    });

    it('keeps hex colours and writes them out in full, in lower case', () => {
      const forms: [string, string][] = [
        ['#ef4444', '#ef4444'],
        ['#EF4444', '#ef4444'],
        ['#1af', '#11aaff'],
        ['#FA0', '#ffaa00'],
        ['#00000080', '#00000080'],
        ['#C6F84FCC', '#c6f84fcc'],
      ];
      for (const [written, read] of forms) {
        const s = withClip('video', { label: written });
        s.doc.transact(() => {
          s.doc.getMap('markers').set('m', { frame: 10, name: 'Beat', color: written, note: '' });
          s.doc.getMap('settings').set('background', written);
        });
        const p = s.get();
        expect(p.clips.c.label).toBe(read);
        expect(p.markers.m.color).toBe(read);
        expect(p.settings.background).toBe(read);
      }
      // No label is a value of its own: the chip takes the colour of its type.
      expect(withClip('video', { label: null }).get().clips.c.label).toBeNull();
    });

    it('reads the colours of titles, shapes, effects and transitions the same way', () => {
      const overlay = makeEffect('fill');
      const unknown = {
        id: 'fx9',
        type: 'fromTheFuture',
        enabled: true,
        params: { color: remote, amount: 1 },
      };
      const s = withClip('text', {
        text: {
          ...DEFAULT_TEXT,
          color: remote,
          gradient: { enabled: true, from: '#ABC', to: remote, angle: 30 },
          stroke: { enabled: true, color: remote, width: 0.1 },
          shadow: { ...DEFAULT_TEXT.shadow, color: remote },
          bg: { ...DEFAULT_TEXT.bg, enabled: true, color: '#00000080' },
        },
        shape: {
          ...DEFAULT_SHAPE,
          fill: remote,
          stroke: '#0F0',
          gradient: { enabled: true, from: remote, to: '#a855f7', angle: 45 },
        },
        effects: [
          { ...overlay, params: { ...overlay.params, color: remote } },
          { ...makeEffect('duotone'), params: { shadow: '#1B1464', highlight: remote, amount: 0.5 } },
          unknown,
        ],
        transIn: { ...makeTransition('dipToBlack', 12), params: { color: remote } },
        transOut: { ...makeTransition('flash', 8), params: { color: '#FFF', intensity: 2 } },
      });
      const c = s.get().clips.c;
      expect(c.text).toEqual({
        ...DEFAULT_TEXT,
        gradient: { enabled: true, from: '#aabbcc', to: DEFAULT_TEXT.gradient.to, angle: 30 },
        stroke: { enabled: true, color: DEFAULT_TEXT.stroke.color, width: 0.1 },
        bg: { ...DEFAULT_TEXT.bg, enabled: true, color: '#00000080' },
      });
      expect(c.shape).toEqual({
        ...DEFAULT_SHAPE,
        stroke: '#00ff00',
        gradient: { enabled: true, from: DEFAULT_SHAPE.gradient.from, to: '#a855f7', angle: 45 },
      });
      // A colour nobody can use gives way to the one the effect starts with.
      expect(c.effects[0].params).toEqual(overlay.params);
      expect(c.effects[1].params).toEqual({ shadow: '#1b1464', highlight: '#ff5e62', amount: 0.5 });
      expect(c.transIn!.params).toEqual({ color: '#000000' });
      expect(c.transOut!.params).toEqual({ color: '#ffffff', intensity: 2 });
      // An effect this version does not know has no schema to say which strings are colours, and
      // nothing draws controls for it.
      expect(c.effects[2]).toEqual(unknown);
      expect(JSON.stringify({ ...c, effects: c.effects.slice(0, 2) })).not.toContain('tracker.example');
      expect(parseProjectFile(serializeProject(s.get()))).toEqual(s.get());
      expect(() => exercise(s.get())).not.toThrow();
    });

    it('reads a hostile project file like a hostile document', () => {
      const s = withClip('shape', { label: '#ef4444', shape: { ...DEFAULT_SHAPE, fill: '#123456' } });
      s.commit([{ op: 'setMarker', marker: { id: 'm', frame: 3, name: '', color: '#10b981', note: '' } }]);
      const file = JSON.parse(serializeProject(s.get()));
      expect(parseProjectFile(JSON.stringify(file))).toEqual(s.get());
      file.project.clips.c.label = remote;
      file.project.clips.c.shape.fill = remote;
      file.project.markers.m.color = remote;
      file.project.settings.background = remote;
      const loaded = parseProjectFile(JSON.stringify(file))!;
      expect(loaded.clips.c.label).toBeNull();
      expect(loaded.clips.c.shape!.fill).toBe(DEFAULT_SHAPE.fill);
      expect(loaded.markers.m.color).toBe('#f59e0b');
      expect(loaded.settings.background).toBe('#000000');
      expect(JSON.stringify(loaded)).not.toContain('tracker.example');
    });
  });

  it('saves and loads project files', () => {
    const s = new ProjectStore();
    s.initIfEmpty({ name: 'File test' });
    const track = tracksOf(s.get()).video[0];
    s.commit([{ op: 'addClip', clip: makeClip('text', track.id, { duration: 30 }) }]);
    const text = serializeProject(s.get());
    const loaded = parseProjectFile(text)!;
    expect(loaded.settings.name).toBe('File test');
    expect(Object.keys(loaded.clips)).toHaveLength(1);
    expect(parseProjectFile('{"nope":1}')).toBeNull();
    expect(parseProjectFile('not json')).toBeNull();

    const t = new ProjectStore();
    t.initIfEmpty();
    t.replaceAll(loaded);
    expect(t.get().settings.name).toBe('File test');
    expect(Object.keys(t.get().clips)).toHaveLength(1);
    t.undo();
    expect(Object.keys(t.get().clips)).toHaveLength(0);
  });
});

/** A clip that counts something in frames wherever a clip can. */
const timed = (trackId: string): Clip =>
  makeClip('text', trackId, {
    start: 30,
    duration: 60,
    fadeIn: 10,
    fadeOut: 20,
    keyframes: {
      opacity: [
        { t: 0, v: 0, e: 'linear' },
        { t: 15, v: 1, e: 'hold' },
      ],
    },
    transIn: makeTransition('crossDissolve', 12),
    transOut: makeTransition('dipToBlack', 6),
    text: {
      ...DEFAULT_TEXT,
      animIn: { type: 'fade', duration: 15 },
      animOut: { type: 'fade', duration: 9 },
    },
  });
/** `timed` after going from 30 to 60 frames a second. */
const doubled = (c: Clip): Clip => ({
  ...c,
  start: 60,
  duration: 120,
  fadeIn: 20,
  fadeOut: 40,
  keyframes: {
    opacity: [
      { t: 0, v: 0, e: 'linear' },
      { t: 30, v: 1, e: 'hold' },
    ],
  },
  transIn: { ...c.transIn!, duration: 24 },
  transOut: { ...c.transOut!, duration: 12 },
  text: { ...c.text!, animIn: { type: 'fade', duration: 30 }, animOut: { type: 'fade', duration: 18 } },
});

describe('clips whose track is gone', () => {
  /** Two stores that only exchange updates when `sync()` is called. */
  const offlinePair = () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    const sync = () => {
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
    };
    sync();
    return { a, b, sync };
  };

  it('hides a clip when the track under it is undone away and returns it on redo', () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    const base = tracksOf(a.get()).video[0];
    const keep = makeClip('video', base.id, { start: 0, duration: 50 });
    a.commit([{ op: 'addClip', clip: keep }]);

    const added = addTrack(b.get(), 'video');
    b.commit(added.edits);
    const clip = makeClip('video', added.trackId, { start: 300, duration: 100 });
    a.commit([{ op: 'addClip', clip }]);
    expect(b.get().clips[clip.id]).toEqual(clip);
    const keptBefore = a.get().clips[keep.id];

    b.undo();
    for (const s of [a, b]) {
      const p = s.get();
      expect(p.tracks[added.trackId]).toBeUndefined();
      expect(p.clips[clip.id]).toBeUndefined();
      expect(sequenceEnd(p)).toBe(50);
      expect(snapPoints(p, new Set())).toEqual([0, 50]);
      expect(clipsUnderFrame(p, 350)).toEqual([]);
      expect(displayTracks(p).map((t) => t.id)).not.toContain(added.trackId);
    }
    // The clip nobody touched is the very same object.
    expect(a.get().clips[keep.id]).toBe(keptBefore);
    // The clip is still in the document, waiting for its track.
    expect(a.doc.getMap('clips').has(clip.id)).toBe(true);

    b.redo();
    for (const s of [a, b]) {
      expect(s.get().tracks[added.trackId]).toBeDefined();
      expect(s.get().clips[clip.id]).toEqual(clip);
      expect(sequenceEnd(s.get())).toBe(400);
    }
    expect(a.get().clips).toEqual(b.get().clips);
  });

  it('hides a clip added while someone else deleted its track, until the delete is undone', () => {
    const { a, b, sync } = offlinePair();
    const track = tracksOf(a.get()).video[1];
    const old = makeClip('video', track.id, { start: 0, duration: 40 });
    a.commit([{ op: 'addClip', clip: old }]);
    sync();

    a.commit(removeTrack(a.get(), track.id));
    const late = makeClip('video', track.id, { start: 100, duration: 60 });
    b.commit([{ op: 'addClip', clip: late }]);
    expect(b.get().clips[late.id]).toEqual(late);
    sync();
    for (const s of [a, b]) {
      expect(s.get().tracks[track.id]).toBeUndefined();
      expect(Object.keys(s.get().clips)).toEqual([]);
      expect(sequenceEnd(s.get())).toBe(0);
      expect(() => resolveFrame(s.get(), 120)).not.toThrow();
    }

    a.undo();
    sync();
    for (const s of [a, b]) {
      expect(s.get().tracks[track.id]).toBeDefined();
      expect(s.get().clips[old.id]).toEqual(old);
      expect(s.get().clips[late.id]).toEqual(late);
    }
    expect(a.get()).toEqual(b.get());
  });

  it('follows a clip that is moved onto a missing track and back', () => {
    const { a, b, sync } = offlinePair();
    const [v1, v2] = tracksOf(a.get()).video;
    const clip = makeClip('video', v1.id, { start: 0, duration: 40 });
    a.commit([{ op: 'addClip', clip }]);
    sync();
    a.commit(removeTrack(a.get(), v2.id));
    b.commit([{ op: 'updateClip', id: clip.id, patch: { trackId: v2.id } }]);
    sync();
    expect(a.get().clips[clip.id]).toBeUndefined();
    expect(b.get().clips[clip.id]).toBeUndefined();
    b.undo();
    sync();
    expect(a.get().clips[clip.id]).toEqual(clip);
    expect(b.get().clips[clip.id]).toEqual(clip);
  });

  it('keeps the clip map and untouched clips referentially stable across track changes', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const [v1, v2] = tracksOf(s.get()).video;
    const one = makeClip('video', v1.id, { start: 0, duration: 10 });
    const two = makeClip('video', v2.id, { start: 0, duration: 10 });
    s.commit([
      { op: 'addClip', clip: one },
      { op: 'addClip', clip: two },
    ]);
    const clips = s.get().clips;
    let calls = 0;
    s.subscribe(() => calls++);

    // Changing a track, or adding and removing an empty one, leaves the clip map alone.
    s.commit([{ op: 'updateTrack', id: v1.id, patch: { name: 'Main', muted: true } }]);
    const extra = addTrack(s.get(), 'audio');
    s.commit(extra.edits);
    s.commit(removeTrack(s.get(), extra.trackId));
    expect(s.get().clips).toBe(clips);
    expect(calls).toBe(3);

    // Removing only the track (as an undo of "add track" does) drops its clip and nothing else.
    s.commit([{ op: 'removeTrack', id: v2.id }]);
    expect(calls).toBe(4);
    expect(s.get().clips).not.toBe(clips);
    expect(Object.keys(s.get().clips)).toEqual([one.id]);
    expect(s.get().clips[one.id]).toBe(clips[one.id]);

    // An edit to the hidden clip changes nothing anyone can see, so nobody is notified.
    const hidden = s.get().clips;
    s.commit([{ op: 'updateClip', id: two.id, patch: { opacity: 0.5 } }]);
    expect(s.get().clips).toBe(hidden);
    expect(calls).toBe(4);

    s.undo();
    s.undo();
    expect(s.get().clips[two.id]).toEqual(two);
    expect(s.get().clips[one.id]).toBe(clips[one.id]);
  });

  it('reads an existing document without its trackless clips and drops them from project files', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const [v1, v2] = tracksOf(s.get()).video;
    const one = makeClip('video', v1.id, { start: 0, duration: 10 });
    const two = makeClip('video', v2.id, { start: 0, duration: 99 });
    s.commit([
      { op: 'addClip', clip: one },
      { op: 'addClip', clip: two },
    ]);
    const file = serializeProject(s.get());
    s.commit([{ op: 'removeTrack', id: v2.id }]);

    const reopened = new ProjectStore(s.doc);
    expect(Object.keys(reopened.get().clips)).toEqual([one.id]);
    expect(sequenceEnd(reopened.get())).toBe(10);

    const edited = JSON.parse(file);
    delete edited.project.tracks[v2.id];
    expect(Object.keys(parseProjectFile(JSON.stringify(edited))!.clips)).toEqual([one.id]);
  });

  it('lists the hidden clips, as they are now', () => {
    const { a, b, sync } = offlinePair();
    const [v1, v2] = tracksOf(a.get()).video;
    const shown = makeClip('video', v1.id, { start: 0, duration: 10 });
    const one = makeClip('video', v2.id, { start: 0, duration: 40 });
    const two = makeClip('text', v2.id, { start: 50, duration: 20, text: DEFAULT_TEXT });
    a.commit([shown, one, two].map((clip): Edit => ({ op: 'addClip', clip })));
    sync();
    expect(a.hiddenClips()).toEqual([]);

    a.commit([{ op: 'removeTrack', id: v2.id }]);
    a.commit([{ op: 'updateClip', id: one.id, patch: { name: 'Kept' } }]);
    sync();
    const byId = (list: Clip[]) => list.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
    for (const s of [a, b, new ProjectStore(a.doc)]) {
      expect(byId(s.hiddenClips())).toEqual(byId([{ ...one, name: 'Kept' }, two]));
      expect(Object.keys(s.get().clips)).toEqual([shown.id]);
    }

    // Giving one a track that exists is all it takes to have it back.
    b.commit([{ op: 'updateClip', id: two.id, patch: { trackId: v1.id } }]);
    sync();
    for (const s of [a, b]) {
      expect(s.hiddenClips()).toEqual([{ ...one, name: 'Kept' }]);
      expect(s.get().clips[two.id]).toEqual({ ...two, trackId: v1.id });
    }
    a.commit([{ op: 'removeClip', id: one.id }]);
    expect(a.hiddenClips()).toEqual([]);
  });

  it('re-times hidden clips with the frame rate, for everyone', () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    const [v1, v2] = tracksOf(a.get()).video;
    const shown = timed(v1.id);
    const hidden = timed(v2.id);
    a.commit([
      { op: 'addClip', clip: shown },
      { op: 'addClip', clip: hidden },
    ]);
    a.commit([{ op: 'removeTrack', id: v2.id }]);
    expect(b.hiddenClips()).toEqual([hidden]);

    // Someone else changes the rate while the clip has no track.
    b.commit(changeFrameRate(b.get(), 60, 1));
    for (const s of [a, b]) {
      expect(s.get().settings.fpsNum).toBe(60);
      expect(s.get().clips[shown.id]).toEqual(doubled(shown));
      expect(s.hiddenClips()).toEqual([doubled(hidden)]);
    }

    // The track comes back: its clip is where it was in real time, like the one that never left.
    a.undo();
    for (const s of [a, b]) {
      expect(s.hiddenClips()).toEqual([]);
      expect(s.get().clips[hidden.id]).toEqual(doubled(hidden));
    }
    expect(a.get()).toEqual(b.get());
    expect(new ProjectStore(b.doc).get()).toEqual(b.get());
  });

  it('re-times a clip that waits for an undone track to be added again', () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    const added = addTrack(a.get(), 'video');
    a.commit(added.edits);
    const clip = makeClip('video', added.trackId, { start: 100, duration: 50, fadeOut: 25 });
    b.commit([{ op: 'addClip', clip }]);
    a.undo();
    expect(a.hiddenClips()).toEqual([clip]);

    b.commit(changeFrameRate(b.get(), 24, 1));
    a.redo();
    for (const s of [a, b]) {
      expect(s.get().clips[clip.id]).toEqual({ ...clip, start: 80, duration: 40, fadeOut: 20 });
      expect(framesToSeconds(sequenceEnd(s.get()), s.get().settings)).toBe(5);
    }
  });

  it('undoes and redoes the re-timing of hidden clips with the rate change', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const v2 = tracksOf(s.get()).video[1];
    const clip = timed(v2.id);
    s.commit([{ op: 'addClip', clip }]);
    s.commit([{ op: 'removeTrack', id: v2.id }]);
    s.commit(changeFrameRate(s.get(), 60, 1));
    expect(s.hiddenClips()).toEqual([doubled(clip)]);

    s.undo();
    expect(s.get().settings.fpsNum).toBe(30);
    expect(s.hiddenClips()).toEqual([clip]);
    s.undo();
    expect(s.get().clips[clip.id]).toEqual(clip);

    s.redo();
    s.redo();
    expect(s.get().settings.fpsNum).toBe(60);
    expect(s.hiddenClips()).toEqual([doubled(clip)]);
    expect(s.canRedo).toBe(false);
  });

  it('leaves hidden clips alone unless the rate really changes', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const v2 = tracksOf(s.get()).video[1];
    // Half a frame of fade would be rounded by a re-timing.
    const clip = makeClip('video', v2.id, { start: 30, duration: 60, fadeIn: 2.5 });
    s.commit([{ op: 'addClip', clip }]);
    s.commit([{ op: 'removeTrack', id: v2.id }]);
    const stored = () => JSON.stringify((s.doc.getMap('clips').get(clip.id) as Y.Map<unknown>).toJSON());
    const before = stored();

    s.commit([{ op: 'settings', patch: { name: 'Renamed', background: '#101010' } }]);
    s.commit(changeFrameRate(s.get(), 30, 1));
    s.commit(changeFrameRate(s.get(), 30000, 1000));
    // There and back inside one commit is no change at all.
    s.commit([...changeFrameRate(s.get(), 60, 1), { op: 'settings', patch: { fpsNum: 30, fpsDen: 1 } }]);
    expect(stored()).toBe(before);
    expect(s.hiddenClips()).toEqual([clip]);

    // Two changes in one commit count as the one they add up to.
    s.commit([...changeFrameRate(s.get(), 60, 1), { op: 'settings', patch: { fpsNum: 15, fpsDen: 1 } }]);
    expect(s.hiddenClips()).toEqual([{ ...clip, start: 15, duration: 30, fadeIn: 1 }]);
  });
});

describe('undo and redo across a change of frame rate', () => {
  /** Two stores that see each other's edits as they are made, on a project of 30 frames a second. */
  const pair = () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    return { a, b };
  };
  const marker = (frame: number) => ({ id: 'm1', frame, name: 'Beat', color: '#f59e0b', note: '' });

  it('brings a deleted track back with its clips where they were in real time', () => {
    const { a, b } = pair();
    const [v1, v2] = tracksOf(a.get()).video;
    const stays = timed(v1.id);
    const goes = timed(v2.id);
    a.commit([
      { op: 'addClip', clip: stays },
      { op: 'addClip', clip: goes },
    ]);
    // Deleting a track takes its clips out of the document: nothing is left to re-time.
    a.commit(removeTrack(a.get(), v2.id));
    expect(b.hiddenClips()).toEqual([]);
    b.commit(changeFrameRate(b.get(), 60, 1));

    a.undo();
    for (const s of [a, b]) {
      expect(s.get().tracks[v2.id]).toBeDefined();
      expect(s.get().clips[stays.id]).toEqual(doubled(stays));
      expect(s.get().clips[goes.id]).toEqual(doubled(goes));
    }
    expect(a.get()).toEqual(b.get());
    expect(new ProjectStore(b.doc).get()).toEqual(b.get());

    // The re-timing belongs to the undo: one redo takes all of it away, one undo brings it back.
    expect(a.undoManager.redoStack).toHaveLength(1);
    a.redo();
    expect(a.canRedo).toBe(false);
    for (const s of [a, b]) {
      expect(s.get().tracks[v2.id]).toBeUndefined();
      expect(Object.keys(s.get().clips)).toEqual([stays.id]);
      expect(s.hiddenClips()).toEqual([]);
    }
    a.undo();
    expect(b.get().clips[goes.id]).toEqual(doubled(goes));
    expect(a.get()).toEqual(b.get());
  });

  it('keeps one time base on a track that got a clip while it was being deleted', () => {
    const a = new ProjectStore();
    a.initIfEmpty({ fpsNum: 60, fpsDen: 1 });
    const b = new ProjectStore();
    const sync = () => {
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
    };
    sync();
    const track = tracksOf(a.get()).video[1];
    const old = makeClip('video', track.id, { start: 0, duration: 80 });
    a.commit([{ op: 'addClip', clip: old }]);
    sync();
    a.commit(removeTrack(a.get(), track.id));
    const late = makeClip('video', track.id, { start: 100, duration: 60 });
    b.commit([{ op: 'addClip', clip: late }]);
    sync();
    // The late clip waits without a track and is re-timed; the deleted one is not there to be.
    b.commit(changeFrameRate(b.get(), 30, 1));
    sync();

    a.undo();
    sync();
    for (const s of [a, b]) {
      expect(s.get().clips[old.id]).toEqual({ ...old, duration: 40 });
      expect(s.get().clips[late.id]).toEqual({ ...late, start: 50, duration: 30 });
    }
    expect(a.get()).toEqual(b.get());
  });

  it('re-times a single field that an undo puts back', () => {
    const { a, b } = pair();
    const v1 = tracksOf(a.get()).video[0];
    const clip = makeClip('video', v1.id, { start: 30, duration: 60, fadeIn: 15 });
    a.commit([{ op: 'addClip', clip }]);
    a.commit([{ op: 'updateClip', id: clip.id, patch: { start: 0 } }]);
    a.commit([{ op: 'updateClip', id: clip.id, patch: { fadeIn: 0 } }]);
    // Neither zero is touched by the change of rate, so both undos go through.
    b.commit(changeFrameRate(b.get(), 60, 1));
    expect(a.get().clips[clip.id]).toMatchObject({ start: 0, duration: 120, fadeIn: 0 });

    a.undo();
    expect(b.get().clips[clip.id]).toMatchObject({ start: 0, duration: 120, fadeIn: 30 });
    a.undo();
    expect(b.get().clips[clip.id]).toMatchObject({ start: 60, duration: 120, fadeIn: 30 });
    a.redo();
    a.redo();
    expect(b.get().clips[clip.id]).toMatchObject({ start: 0, duration: 120, fadeIn: 0 });
    expect(a.canRedo).toBe(false);
    expect(a.get()).toEqual(b.get());
  });

  it('lets an earlier step take away what came back re-timed', () => {
    const { a, b } = pair();
    const v2 = tracksOf(a.get()).video[1];
    const clip = makeClip('video', v2.id, { start: 30, duration: 60 });
    a.commit([{ op: 'addClip', clip }]);
    a.commit([
      { op: 'updateClip', id: clip.id, patch: { fadeIn: 15, transIn: makeTransition('crossDissolve', 12) } },
    ]);
    a.commit(removeTrack(a.get(), v2.id));
    b.commit(changeFrameRate(b.get(), 60, 1));

    a.undo();
    expect(b.get().clips[clip.id]).toMatchObject({ start: 60, fadeIn: 30, transIn: { duration: 24 } });
    // The step before gave the clip its fade and transition. Undoing it removes them, re-timed as
    // they are, and does not reach past them for the step that added the clip.
    a.undo();
    expect(b.get().clips[clip.id]).toEqual({ ...clip, start: 60, duration: 120 });
    a.undo();
    expect(b.get().clips[clip.id]).toBeUndefined();
    expect(b.get().tracks[v2.id]).toBeDefined();

    a.redo();
    a.redo();
    expect(b.get().clips[clip.id]).toMatchObject({ start: 60, fadeIn: 30, transIn: { duration: 24 } });
    a.redo();
    expect(a.canRedo).toBe(false);
    expect(b.get().tracks[v2.id]).toBeUndefined();
    expect(a.get()).toEqual(b.get());
  });

  it('re-times a marker that comes back', () => {
    const { a, b } = pair();
    a.commit([{ op: 'setMarker', marker: marker(30) }]);
    a.commit([{ op: 'removeMarker', id: 'm1' }]);
    b.commit(changeFrameRate(b.get(), 60, 1));
    a.undo();
    expect(b.get().markers.m1).toEqual(marker(60));
    a.redo();
    expect(b.get().markers.m1).toBeUndefined();
    a.undo();
    expect(b.get().markers.m1).toEqual(marker(60));

    // And one that a redo brings back, after the step that added it was undone at the other rate.
    a.undo();
    expect(b.get().markers.m1).toBeUndefined();
    b.commit(changeFrameRate(b.get(), 30, 1));
    a.redo();
    expect(b.get().markers.m1).toEqual(marker(30));
    expect(a.get()).toEqual(b.get());
  });

  it('re-times what a redo puts back', () => {
    const { a, b } = pair();
    const v1 = tracksOf(a.get()).video[0];
    const clip = timed(v1.id);
    a.commit([{ op: 'addClip', clip }]);
    a.undo();
    b.commit(changeFrameRate(b.get(), 60, 1));
    a.redo();
    expect(a.get().clips[clip.id]).toEqual(doubled(clip));
    expect(b.get().clips[clip.id]).toEqual(doubled(clip));
    a.undo();
    expect(b.get().clips[clip.id]).toBeUndefined();
  });

  it('re-times what others did since when a change of rate is undone, and gives it back on redo', () => {
    const { a, b } = pair();
    const v1 = tracksOf(a.get()).video[0];
    const old = timed(v1.id);
    a.commit([{ op: 'addClip', clip: old }]);
    b.commit(changeFrameRate(b.get(), 60, 1));
    // Made at 60 frames a second, and no part of the change that B is about to undo.
    const late = makeClip('video', v1.id, { start: 240, duration: 120, fadeOut: 30 });
    a.commit([
      { op: 'addClip', clip: late },
      { op: 'updateClip', id: old.id, patch: { start: 600 } },
      { op: 'setMarker', marker: marker(300) },
    ]);
    const at60 = a.get();

    b.undo();
    for (const s of [a, b]) {
      expect(s.get().settings.fpsNum).toBe(30);
      expect(s.get().clips[late.id]).toEqual({ ...late, start: 120, duration: 60, fadeOut: 15 });
      expect(s.get().clips[old.id]).toEqual({ ...old, start: 300 });
      expect(s.get().markers.m1).toEqual(marker(150));
    }
    b.redo();
    expect(b.canRedo).toBe(false);
    expect(a.get()).toEqual(at60);
    expect(b.get()).toEqual(at60);
  });

  it('returns to the numbers of the rate that returns', () => {
    const { a, b } = pair();
    const [v1, v2] = tracksOf(a.get()).video;
    const stays = timed(v1.id);
    const goes = timed(v2.id);
    a.commit([
      { op: 'addClip', clip: stays },
      { op: 'addClip', clip: goes },
    ]);
    a.commit(removeTrack(a.get(), v2.id));
    b.commit(changeFrameRate(b.get(), 60, 1));
    a.undo();
    b.undo();
    for (const s of [a, b]) {
      expect(s.get().settings.fpsNum).toBe(30);
      expect(s.get().clips[stays.id]).toEqual(stays);
      expect(s.get().clips[goes.id]).toEqual(goes);
    }
  });

  it('undoes a change of rate exactly, also where the change left a value as it was', () => {
    const s = new ProjectStore();
    s.initIfEmpty({ fpsNum: 60, fpsDen: 1 });
    const v1 = tracksOf(s.get()).video[0];
    // Half of one frame rounds to one frame: at 30 frames a second all of this reads the same.
    const tiny = makeClip('video', v1.id, {
      start: 1,
      duration: 1,
      fadeIn: 1,
      transIn: makeTransition('crossDissolve', 1),
    });
    const odd = makeClip('video', v1.id, { start: 3, duration: 5, fadeIn: 2.5, fadeOut: 1 });
    s.commit([
      { op: 'addClip', clip: tiny },
      { op: 'addClip', clip: odd },
      { op: 'setMarker', marker: marker(1) },
    ]);
    const at60 = s.get();
    s.commit(changeFrameRate(s.get(), 30, 1));
    const at30 = s.get();
    expect(at30.clips[tiny.id]).toEqual(tiny);
    expect(at30.clips[odd.id]).toMatchObject({ start: 2, duration: 2, fadeIn: 1, fadeOut: 1 });

    s.undo();
    expect(s.get()).toEqual(at60);
    s.redo();
    expect(s.get()).toEqual(at30);
    s.undo();
    expect(s.get()).toEqual(at60);
  });

  it('starts a new step when the rate changes under a gesture', () => {
    const { a, b } = pair();
    const v1 = tracksOf(a.get()).video[0];
    const clip = makeClip('video', v1.id, { start: 30, duration: 60 });
    a.commit([{ op: 'addClip', clip }]);
    a.beginGesture();
    for (const start of [40, 50])
      a.commit([{ op: 'updateClip', id: clip.id, patch: { start } }], { merge: true });
    expect(a.undoManager.undoStack).toHaveLength(2);
    b.commit(changeFrameRate(b.get(), 60, 1));
    for (const start of [120, 140])
      a.commit([{ op: 'updateClip', id: clip.id, patch: { start } }], { merge: true });
    expect(a.undoManager.undoStack).toHaveLength(3);

    // What was dragged at 60 frames a second, then what was dragged at 30.
    a.undo();
    expect(b.get().clips[clip.id].start).toBe(100);
    a.undo();
    expect(b.get().clips[clip.id].start).toBe(60);
    a.redo();
    a.redo();
    expect(b.get().clips[clip.id].start).toBe(140);
  });
});

describe('ReviewStore', () => {
  it('syncs comments and replies', () => {
    const a = new ReviewStore();
    const b = new ReviewStore();
    connect(a.doc, b.doc);
    const id = a.add({
      frame: 120,
      text: 'Tighten this cut',
      authorId: 'u1',
      authorName: 'Ana',
      authorColor: '#f00',
      x: null,
      y: null,
    });
    a.add({
      frame: 10,
      text: 'Love the open',
      authorId: 'u1',
      authorName: 'Ana',
      authorColor: '#f00',
      x: 0.5,
      y: 0.5,
    });
    expect(b.get().map((c) => c.frame)).toEqual([10, 120]);
    b.reply(id, { text: 'Done', authorId: 'u2', authorName: 'Ben', authorColor: '#0f0' });
    b.update(id, { resolved: true });
    const c = a.get().find((x) => x.id === id)!;
    expect(c.replies).toHaveLength(1);
    expect(c.resolved).toBe(true);
    a.remove(id);
    expect(b.get()).toHaveLength(1);
  });
});
