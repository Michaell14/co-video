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

  it("keeps the white space after a character wider than the box on that character's line", () => {
    expect(wrap('😀', 1)).toEqual(['😀']);
    expect(wrap('a 😀  ', 1)).toEqual(['a', '😀  ']);
    expect(wrap('😀 a', 1)).toEqual(['😀', 'a']);
  });

  it('wraps every paragraph by itself', () => {
    expect(wrap('one two three\nfour five six', 9)).toEqual(['one two', 'three', 'four five', 'six']);
    expect(wrap('\n\none two three', 7)).toEqual(['', '', 'one two', 'three']);
  });

  it('breaks a line after a hyphen, which stays on it', () => {
    expect(wrap('Our award-winning studio', 14)).toEqual(['Our award-', 'winning studio']);
    expect(wrap('state-of-the-art', 10)).toEqual(['state-of-', 'the-art']);
    expect(wrap('peut-être', 6)).toEqual(['peut-', 'être']);
    // The hyphen has no room on the first line: the second begins with it.
    expect(wrap('well-known', 4)).toEqual(['well', '-', 'know', 'n']);
  });

  it('keeps a minus sign with its number, and a hyphen with what closes the phrase', () => {
    expect(wrap('x -5', 3)).toEqual(['x', '-5']);
    expect(wrap('x à-5', 4)).toEqual(['x', 'à-5']);
    expect(wrap('on route-66', 9)).toEqual(['on route-', '66']);
    expect(wrap('ab cd-.', 6)).toEqual(['ab', 'cd-.']);
    expect(wrap('ab (c-)', 6)).toEqual(['ab', '(c-)']);
  });

  it('keeps a hyphen that begins a word with a word that is not ASCII, as a browser does', () => {
    expect(wrap('ab -cd', 4)).toEqual(['ab -', 'cd']);
    expect(wrap('ab -çd', 4)).toEqual(['ab', '-çd']);
    // Forced apart in front of the hyphen, what is left is a line that begins with one.
    expect(wrap('abcd-çççç', 4)).toEqual(['abcd', '-ççç', 'ç']);
    expect(wrap('abcd-1234', 4)).toEqual(['abcd', '-123', '4']);
    expect(wrap('abc-1234', 4)).toEqual(['abc-', '1234']);
  });

  it('breaks after a question mark and before a bracket where a browser does', () => {
    expect(wrap('to watch?v=1', 9)).toEqual(['to watch?', 'v=1']);
    expect(wrap('ab so?!', 6)).toEqual(['ab', 'so?!']);
    expect(wrap('ab c.(de)', 5)).toEqual(['ab c.', '(de)']);
    expect(wrap('ab c(d)', 4)).toEqual(['ab', 'c(d)']);
    expect(wrap('ab and/or', 7)).toEqual(['ab', 'and/or']);
    expect(wrap('ab да/нет', 6)).toEqual(['ab да/', 'нет']);
  });

  it('breaks after a dash and an ellipsis, and on both sides of an em dash', () => {
    expect(wrap('in 2020–2024', 8)).toEqual(['in 2020–', '2024']);
    expect(wrap('so wait…what', 8)).toEqual(['so wait…', 'what']);
    expect(wrap('a Wait—what', 7)).toEqual(['a Wait—', 'what']);
    expect(wrap('a Wait—what', 6)).toEqual(['a Wait', '—what']);
    expect(wrap('a——b', 2)).toEqual(['a', '——', 'b']);
  });

  it('breaks nowhere that one character clings to the other', () => {
    expect(wrap('ab “—', 4)).toEqual(['ab', '“—']);
    expect(wrap('ab c–”', 4)).toEqual(['ab', 'c–”']);
    expect(wrap('ab x—!', 4)).toEqual(['ab x', '—!']);
    expect(wrap('ab c…–', 4)).toEqual(['ab', 'c…–']);
    // A mark stays on the character it belongs to, a hyphen as well.
    expect(wrap('abc-\u0301d', 4)).toEqual(['abc-\u0301', 'd']);
  });

  it('breaks at no no-break space, and keeps a no-break hyphen whole', () => {
    expect(wrap('go 10\u00a0km', 5)).toEqual(['go', '10\u00a0km']);
    expect(wrap('ab co\u2011op', 5)).toEqual(['ab', 'co\u2011op']);
    expect(wrap('ab c—\u00a0d', 5)).toEqual(['ab c', '—\u00a0d']);
    // A hyphen lets go of it all the same.
    expect(wrap('ab c-\u00a0d', 5)).toEqual(['ab c-', '\u00a0d']);
  });

  it('breaks after a space of a set width, which takes room on its line', () => {
    expect(wrap('ab\u2003cd', 3)).toEqual(['ab\u2003', 'cd']);
    expect(wrap('ab\u2003cd', 2)).toEqual(['ab', '\u2003', 'cd']);
  });

  it('lets the wide space of East Asian text reach over the edge like any white space', () => {
    expect(wrap('日本\u3000東京', 3)).toEqual(['日本', '東京']);
    expect(wrap('日本\u3000', 2)).toEqual(['日本\u3000']);
  });
});
