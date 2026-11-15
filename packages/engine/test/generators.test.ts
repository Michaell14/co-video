import { describe, expect, it } from 'vitest';
import { wrapLines } from '../src/generators';

/** Every character one unit wide, except that an emoji (of however many code points) is two. */
const measure = (line: string): number => {
  const units = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line));
  return units.reduce((sum, { segment }) => sum + (segment.codePointAt(0)! > 0xffff ? 2 : 1), 0);
};
const wrap = (text: string, width: number | null): string[] => wrapLines(text, width, measure);

describe('wrapLines', () => {
  it('breaks only where the text says so when there is no box', () => {
    expect(wrap('one two three\n\nfour ', null)).toEqual(['one two three', '', 'four ']);
  });

  it('fills each line with as many words as fit', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrap('one two three four', 13)).toEqual(['one two three', 'four']);
    expect(wrap('ab cd', 5)).toEqual(['ab cd']);
  });

  it('gives the white space at a break to neither line, however much of it there is', () => {
    expect(wrap('one two    three', 7)).toEqual(['one two', 'three']);
    expect(wrap('one    two', 5)).toEqual(['one', 'two']);
  });

  it('starts no line with the space that did not fit on the line before', () => {
    // "one two" fills the box to the last unit: the space after it has no room there.
    expect(wrap('one two three', 7)).toEqual(['one two', 'three']);
    expect(wrap('one two three four', 7)).toEqual(['one two', 'three', 'four']);
  });

  it('keeps the white space a paragraph ends with on its last line, also past the edge of the box', () => {
    expect(wrap('one two ', 7)).toEqual(['one two ']);
    expect(wrap('one two   ', 7)).toEqual(['one two   ']);
    expect(wrap('one two three ', 7)).toEqual(['one two', 'three ']);
    expect(wrap('one two \nthree', 7)).toEqual(['one two ', 'three']);
  });

  it('keeps the white space a paragraph begins with', () => {
    expect(wrap('  one two', 7)).toEqual(['  one', 'two']);
    // Wider than the box together with the first word: the word goes below it.
    expect(wrap('     three', 7)).toEqual(['', 'three']);
  });

  it('breaks a word wider than the box between characters, on a line of its own', () => {
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrap('to abcdefghij on', 4)).toEqual(['to', 'abcd', 'efgh', 'ij', 'on']);
    expect(wrap('abcdefgh ij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('never breaks inside a character', () => {
    // A family is seven code units and a flag is four: each stays whole.
    expect(wrap('👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧', 4)).toEqual(['👨‍👩‍👧👨‍👩‍👧', '👨‍👩‍👧']);
    expect(wrap('a🇩🇪🇫🇷b', 3)).toEqual(['a🇩🇪', '🇫🇷b']);
    expect(wrap('ééé', 2)).toEqual(['éé', 'é']);
  });

  it('puts a character wider than the box on a line of its own instead of looping', () => {
    expect(wrap('a😀b', 1)).toEqual(['a', '😀', 'b']);
  });

  it('wraps every paragraph by itself', () => {
    expect(wrap('one two three\nfour five six', 9)).toEqual(['one two', 'three', 'four five', 'six']);
    expect(wrap('\n\none two three', 7)).toEqual(['', '', 'one two', 'three']);
  });
});
