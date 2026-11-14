import { describe, expect, it } from 'vitest';
import { describeCause } from '../src/media/cause';

describe('describeCause', () => {
  it('gives the name of an error and what it said, in one line', () => {
    expect(describeCause(new DOMException('Decoding error.', 'EncodingError'))).toBe(
      'EncodingError: Decoding error.',
    );
    expect(describeCause(new TypeError('AudioData with null format\n  is not supported.'))).toBe(
      'TypeError: AudioData with null format is not supported.',
    );
  });

  it('leaves out a name that says nothing, and names what has no message', () => {
    expect(describeCause(new Error('decoder gave up'))).toBe('decoder gave up');
    expect(describeCause(new DOMException('', 'NotSupportedError'))).toBe('NotSupportedError');
    expect(describeCause('bad data')).toBe('bad data');
    expect(describeCause(undefined)).toBe('Unknown error');
    expect(describeCause({ code: 4 })).toBe('Unknown error');
    expect(describeCause(new Error(''))).toBe('Unknown error');
  });

  it('keeps of an address or a path only the name of the file', () => {
    expect(
      describeCause(
        new Error(
          'Failed to read https://media.example.com/p/8f2/holiday%20clip.mp4?token=s3cret#t=4 (HTTP 502)',
        ),
      ),
    ).toBe('Failed to read holiday%20clip.mp4 (HTTP 502)');
    expect(
      describeCause(new Error('Could not open /Users/ada/Movies/Summer 2024/beach.mov: truncated')),
    ).toBe('Could not open beach.mov: truncated');
    expect(describeCause(new Error('cannot read C:\\Users\\ada\\Videos\\beach.mov'))).toBe(
      'cannot read beach.mov',
    );
    expect(describeCause(new Error('blob:http://localhost:8787/0b7c1c6e-5d0f is gone'))).toBe(
      '0b7c1c6e-5d0f is gone',
    );
  });

  it('leaves what only looks a little like a path alone', () => {
    expect(describeCause(new Error('expected 1/2 of 1024 samples and/or a key frame'))).toBe(
      'expected 1/2 of 1024 samples and/or a key frame',
    );
  });

  it('is cut to what fits beside the sentence it explains', () => {
    const said = describeCause(new Error('x'.repeat(500)));
    expect(said).toHaveLength(200);
    expect(said.endsWith('…')).toBe(true);
  });
});
