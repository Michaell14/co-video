import { describe, expect, it } from 'vitest';
import { parseSubtitles, toSrt, toVtt } from '../src';

describe('subtitle parsing', () => {
  const two = [
    { start: 1, end: 2, text: 'Hello' },
    { start: 3, end: 4, text: 'World' },
  ];

  it('reads SubRip cues with multi-line text and markup', () => {
    const srt = [
      '﻿1',
      '00:00:01,000 --> 00:00:02,500',
      '<i>Hello</i>',
      '{\\an8}there',
      '',
      '2',
      '00:01:03,5 --> 00:01:04,000',
      'World',
      '',
    ].join('\r\n');
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 2.5, text: 'Hello\nthere' },
      { start: 63.5, end: 64, text: 'World' },
    ]);
  });

  it('treats a separator line that holds only spaces or tabs as blank', () => {
    for (const sep of [' ', '\t', ' \t  ']) {
      const text = `1\n00:00:01,000 --> 00:00:02,000\nHello\n${sep}\n2\n00:00:03,000 --> 00:00:04,000\nWorld`;
      expect(parseSubtitles(text)).toEqual(two);
    }
  });

  it('starts a new cue at a timing line even when the blank line before it is missing', () => {
    const text = '1\n00:00:01,000 --> 00:00:02,000\nHello\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n';
    expect(parseSubtitles(text)).toEqual(two);
    // A number is only dropped when it sits directly above the next timing line.
    const counted = '1\n00:00:01,000 --> 00:00:02,000\n3\n2\n1\n\n2\n00:00:03,000 --> 00:00:04,000\nGo';
    expect(parseSubtitles(counted)[0].text).toBe('3\n2\n1');
  });

  it('keeps an arrow in the text as text', () => {
    const text = '1\n00:00:01,000 --> 00:00:02,000\nA --> B\nsee 00:10 --> later\n';
    expect(parseSubtitles(text)).toEqual([{ start: 1, end: 2, text: 'A --> B\nsee 00:10 --> later' }]);
  });

  it('reads WebVTT with a header, notes, identifiers and cue settings', () => {
    const vtt = [
      'WEBVTT - made by hand',
      '',
      'NOTE this --> is a comment',
      'and so is this',
      '',
      'intro',
      '00:01.000 --> 00:02.000 align:start position:10%',
      'Hello',
      '',
      '00:00:03.000 --> 00:00:04.000',
      'World',
    ].join('\n');
    expect(parseSubtitles(vtt)).toEqual(two);
  });

  it('skips cues it cannot time and sorts the rest', () => {
    const text = [
      '1\n00:00:05,000 --> 00:00:04,000\nBackwards',
      '2\nsoon --> later\nNo times',
      '3\n00:00:03,000 --> 00:00:04,000\nWorld',
      '4\n00:00:01,000 --> 00:00:02,000\nHello',
      '5\n00:00:07,000 --> 00:00:08,000\n   ',
    ].join('\n\n');
    expect(parseSubtitles(text)).toEqual(two);
    expect(parseSubtitles('')).toEqual([]);
  });

  it('round-trips through both writers', () => {
    expect(parseSubtitles(toSrt(two))).toEqual(two);
    expect(parseSubtitles(toVtt(two))).toEqual(two);
  });
});
