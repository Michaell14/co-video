import { describe, expect, it } from 'vitest';
import { fitPanels } from '../src/features/editor/layout';
import { readPrefs } from '../src/state/ui';

const FIRST_VISIT = {
  snapping: true,
  linkedSelection: true,
  markersFollow: true,
  defaultTransition: 'crossDissolve',
  leftWidth: 320,
  rightWidth: 316,
  timelineHeight: 320,
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
