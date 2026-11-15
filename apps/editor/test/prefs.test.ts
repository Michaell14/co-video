import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitPanels } from '../src/features/editor/layout';
import { laneHeightsToStore, readPrefs, withLaneHeight, withoutLaneHeights } from '../src/state/ui';

const FIRST_VISIT = {
  snapping: true,
  linkedSelection: true,
  markersFollow: true,
  defaultTransition: 'crossDissolve',
  leftWidth: 320,
  rightWidth: 316,
  timelineHeight: 320,
  laneHeights: {},
  scopes: { waveform: true, parade: true, vectorscope: true, histogram: false },
};

describe('stored interface preferences', () => {
  it('start from the defaults when nothing usable is stored', () => {
    for (const stored of [null, '', '{', 'null', '42', '"wide"', '[]', '[400, 300]']) {
      expect(readPrefs(stored), String(stored)).toEqual(FIRST_VISIT);
    }
  });

  it('come back as they were written', () => {
    const written = {
      snapping: false,
      linkedSelection: false,
      markersFollow: false,
      defaultTransition: 'dipToBlack',
      leftWidth: 412.5,
      rightWidth: 280,
      timelineHeight: 512,
      laneHeights: { q7Yb2mXw0eRt5uIo9pLk: { a1B2c3D4e5F6: 96, g7H8i9J0k1L2: 26 }, second: { v1: 220 } },
      scopes: { waveform: false, parade: true, vectorscope: false, histogram: true },
    };
    expect(readPrefs(JSON.stringify(written))).toEqual(written);
  });

  it('replace a size that is not a finite, plausible number of pixels', () => {
    // JSON has no NaN or Infinity: they are written as null, and 1e999 is read back as Infinity.
    for (const bad of ['null', '"400"', '-120', '0', '1e999', '-1e999', '20000', 'true', '{}', '[400]']) {
      const prefs = readPrefs(`{"leftWidth": ${bad}, "rightWidth": ${bad}, "timelineHeight": ${bad}}`);
      expect([prefs.leftWidth, prefs.rightWidth, prefs.timelineHeight], bad).toEqual([320, 316, 320]);
    }
  });

  it('replace a switch that is not true or false, also inside the scopes', () => {
    for (const bad of ['null', '0', '1', '"false"', '{}', '[]']) {
      const prefs = readPrefs(
        `{"snapping": ${bad}, "linkedSelection": ${bad}, "markersFollow": ${bad}, "scopes": {"waveform": ${bad}, "histogram": ${bad}}}`,
      );
      expect(prefs, bad).toEqual(FIRST_VISIT);
    }
    for (const bad of ['null', '"all"', '7', 'true', '[true, true]']) {
      expect(readPrefs(`{"scopes": ${bad}}`).scopes, bad).toEqual(FIRST_VISIT.scopes);
    }
  });

  it('replace a default transition that is not the name of one', () => {
    for (const bad of [
      'null',
      '7',
      'true',
      '""',
      '"cross dissolve"',
      '"<b>"',
      `"${'x'.repeat(65)}"`,
      '["wipe"]',
    ]) {
      expect(readPrefs(`{"defaultTransition": ${bad}}`).defaultTransition, bad).toBe('crossDissolve');
    }
    // A name no transition has any more is kept here and replaced where it is used.
    expect(readPrefs('{"defaultTransition": "retiredWipe"}').defaultTransition).toBe('retiredWipe');
  });

  it('keep a lane height only for what can be a project and a track, and only one a lane can have', () => {
    for (const bad of [
      'null',
      '7',
      '"tall"',
      '[]',
      '[{"v1": 90}]',
      '{"p1": null}',
      '{"p1": 90}',
      '{"p1": []}',
    ]) {
      expect(readPrefs(`{"laneHeights": ${bad}}`).laneHeights, bad).toEqual({});
    }
    for (const bad of ['null', '"90"', '25', '221', '-90', '1e999', 'true', '{}', '[90]']) {
      const stored = `{"laneHeights": {"p1": {"v1": ${bad}, "a1": 90}, "p2": {"v1": ${bad}}}}`;
      expect(readPrefs(stored).laneHeights, bad).toEqual({ p1: { a1: 90 } });
    }
    // A name that is no id is not kept, whatever stands under it: neither as a project nor as a track.
    const named = readPrefs(
      `{"laneHeights": {"__proto__": {"v1": 90}, "<b>": {"v1": 90}, "p1": {"__proto__": 90, "a b": 90, "v1": 90}}}`,
    ).laneHeights;
    expect(Object.keys(named)).toEqual(['p1']);
    expect(Object.keys(named.p1)).toEqual(['v1']);
    expect(Object.getPrototypeOf(named)).toBe(Object.prototype);
    // No more projects than are kept: the ones written last stay.
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`project${i}`, { v1: 90 }]));
    const kept = Object.keys(readPrefs(JSON.stringify({ laneHeights: many })).laneHeights);
    expect(kept).toHaveLength(50);
    expect([kept[0], kept[49]]).toEqual(['project10', 'project59']);
  });

  it('keep the good fields next to a bad one, and nothing that is not a preference', () => {
    const prefs = readPrefs(
      '{"leftWidth": "wide", "rightWidth": 300, "snapping": false, "scopes": {"parade": false, "rgb": true}, "workspace": "color"}',
    );
    expect(prefs).toEqual({
      ...FIRST_VISIT,
      rightWidth: 300,
      snapping: false,
      scopes: { ...FIRST_VISIT.scopes, parade: false },
    });
  });

  it('give the layout numbers it can work with, whatever was stored', () => {
    const prefs = readPrefs('{"leftWidth": null, "rightWidth": "316px", "timelineHeight": -40}');
    const layout = fitPanels(
      { ...prefs, commentsOpen: false, workspace: 'edit' },
      { width: 1440, height: 900 },
    );
    expect([layout.left, layout.right, layout.timeline]).toEqual([320, 316, 320]);
  });
});

describe('the lane heights of someone who may not edit', () => {
  const tracks = { v1: {}, a1: {} };

  it('are kept by project and by track', () => {
    const one = withLaneHeight({}, 'p1', tracks, 'v1', 90);
    expect(one).toEqual({ p1: { v1: 90 } });
    const two = withLaneHeight(one, 'p1', tracks, 'a1', 120);
    expect(two).toEqual({ p1: { v1: 90, a1: 120 } });
    expect(withLaneHeight(two, 'p2', tracks, 'v1', 40)).toEqual({ p1: { v1: 90, a1: 120 }, p2: { v1: 40 } });
    // A drag that has not moved the edge changes nothing, so nothing is drawn or written again.
    expect(withLaneHeight(two, 'p1', tracks, 'a1', 120)).toBe(two);
  });

  it('let go of tracks the project no longer has when a height is set, and of no other project', () => {
    const before = { p1: { v1: 90, gone: 150 }, p2: { gone: 60 } };
    expect(withLaneHeight(before, 'p1', tracks, 'a1', 120)).toEqual({
      p2: { gone: 60 },
      p1: { v1: 90, a1: 120 },
    });
  });

  it('make room for the project set last by dropping the one set longest ago', () => {
    let all = {};
    for (let i = 0; i < 50; i++) all = withLaneHeight(all, `project${i}`, tracks, 'v1', 90);
    expect(Object.keys(all)).toHaveLength(50);
    // Setting a height in a project that is kept moves it to the end: it is not the next to go.
    all = withLaneHeight(all, 'project0', tracks, 'a1', 100);
    all = withLaneHeight(all, 'project50', tracks, 'v1', 90);
    const kept = Object.keys(all);
    expect(kept).toHaveLength(50);
    expect(kept).not.toContain('project1');
    expect(kept.slice(-2)).toEqual(['project0', 'project50']);
    expect((all as Record<string, unknown>).project0).toEqual({ v1: 90, a1: 100 });
  });

  it('are written without undoing what another tab has kept for its own project meanwhile', () => {
    const loaded = { p1: { v1: 90 }, p2: { v1: 40 } };
    // The other tab has set a height in p2 and in a project this tab has never seen.
    const stored = { p1: { v1: 90 }, p2: { v1: 60 }, p3: { a1: 30 } };
    // A tab that set nothing itself writes back what is there.
    expect(laneHeightsToStore(loaded, loaded, stored)).toEqual(stored);
    // One that set a height in p1 writes that project over what is there, and no other.
    const mine = withLaneHeight(loaded, 'p1', tracks, 'a1', 120);
    const written = laneHeightsToStore(loaded, mine, stored);
    expect(written).toEqual({ p2: { v1: 60 }, p3: { a1: 30 }, p1: { v1: 90, a1: 120 } });
    // Once written, the project is no longer this tab's to write over a later change elsewhere.
    const later = { ...written, p1: { v1: 200 } };
    expect(laneHeightsToStore(mine, mine, later)).toEqual(later);
    // What is kept stays within the number of projects, the ones set here last.
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`project${i}`, { v1: 90 }]));
    const full = Object.keys(laneHeightsToStore({}, { p1: { v1: 90 } }, many));
    expect(full).toHaveLength(50);
    expect([full[0], full[49]]).toEqual(['project1', 'p1']);
  });
});

describe('the lane heights kept for a project that is deleted from this device', () => {
  const KEY = 'tandem.ui.v1';

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('are taken out of what is stored, and nothing else is', () => {
    const stored = JSON.stringify({
      snapping: false,
      laneHeights: { p1: { v1: 90 }, p2: { v1: 40 } },
      // Written by a version that knows more than this one.
      later: { kept: true },
    });
    expect(JSON.parse(withoutLaneHeights(stored, 'p1')!)).toEqual({
      snapping: false,
      laneHeights: { p2: { v1: 40 } },
      later: { kept: true },
    });
    expect(JSON.parse(withoutLaneHeights('{"laneHeights": {"p1": {"v1": 90}}}', 'p1')!)).toEqual({
      laneHeights: {},
    });
  });

  it('leave storage alone when it holds none for the project', () => {
    const stored = '{"snapping": false, "laneHeights": {"p1": {"v1": 90}}}';
    for (const [prefs, project] of [
      [stored, 'p2'],
      [stored, 'constructor'],
      [stored, '__proto__'],
      [null, 'p1'],
      ['', 'p1'],
      ['{', 'p1'],
      ['null', 'p1'],
      ['[]', 'p1'],
      ['{"laneHeights": 7}', 'p1'],
      ['{"laneHeights": ["p1"]}', 'p1'],
    ] as const) {
      expect(withoutLaneHeights(prefs, project), `${prefs} / ${project}`).toBeNull();
    }
  });

  it('go from this tab and from storage at once, and the next save does not bring them back', async () => {
    vi.useFakeTimers();
    const data = new Map<string, string>();
    const write = (prefs: object): void => void data.set(KEY, JSON.stringify(prefs));
    const read = (): Record<string, unknown> => JSON.parse(data.get(KEY) ?? '{}');
    write({ timelineHeight: 400, laneHeights: { p1: { v1: 90 }, p2: { v1: 40 } } });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    });
    // The module as a tab that has just loaded has it: it starts from what is stored.
    vi.resetModules();
    const { forgetLaneHeights, useUI } = await import('../src/state/ui');
    expect(useUI.getState().laneHeights).toEqual({ p1: { v1: 90 }, p2: { v1: 40 } });
    // Since then another tab has sized the lanes of a project this one has never seen.
    write({ timelineHeight: 400, laneHeights: { p1: { v1: 90 }, p2: { v1: 40 }, p3: { a1: 30 } } });

    forgetLaneHeights('p1');
    expect(useUI.getState().laneHeights).toEqual({ p2: { v1: 40 } });
    expect(read()).toEqual({ timelineHeight: 400, laneHeights: { p2: { v1: 40 }, p3: { a1: 30 } } });
    forgetLaneHeights('p3');
    expect(useUI.getState().laneHeights).toEqual({ p2: { v1: 40 } });
    expect(read().laneHeights).toEqual({ p2: { v1: 40 } });
    // A project nothing is kept for changes nothing, here or there.
    const before = [useUI.getState().laneHeights, data.get(KEY)];
    forgetLaneHeights('p4');
    expect([useUI.getState().laneHeights, data.get(KEY)]).toEqual(before);
    expect(useUI.getState().laneHeights).toBe(before[0]);

    // The save that follows any change writes the preferences of this tab, without them.
    vi.advanceTimersByTime(400);
    expect(read().laneHeights).toEqual({ p2: { v1: 40 } });
    useUI.getState().set({ snapping: false });
    vi.advanceTimersByTime(400);
    expect(read()).toMatchObject({ snapping: false, timelineHeight: 400, laneHeights: { p2: { v1: 40 } } });
  });

  it('are let go of by a tab whose storage cannot be read or written', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    });
    vi.resetModules();
    const { forgetLaneHeights, useUI } = await import('../src/state/ui');
    useUI.getState().set({ laneHeights: { p1: { v1: 90 } } });
    expect(() => forgetLaneHeights('p1')).not.toThrow();
    expect(useUI.getState().laneHeights).toEqual({});
  });
});
