import { describe, expect, it } from 'vitest';
import { NO_DOC_MEMORY, docFullMessage, type ProjectInfo } from '@tandem/core';
import { availabilityOf, tooLargeNotice, turnedAwayNotice } from '../src/session/saving';

describe('turnedAwayNotice', () => {
  it('says that a full project keeps its changes on the device', () => {
    expect(turnedAwayNotice('project', docFullMessage('project'))).toBe(
      'This project has reached the size the server allows. Changes made here are kept on this device but are not being saved to the server.',
    );
  });

  it('speaks of comments for the review document', () => {
    expect(turnedAwayNotice('review', docFullMessage('review'))).toBe(
      'The comments of this project have reached the size the server allows. Comments made here are kept on this device but are not being saved to the server.',
    );
  });

  it('tells a server short of memory from a full document', () => {
    expect(turnedAwayNotice('project', NO_DOC_MEMORY)).toMatch(
      /^The server has no memory to spare for this project right now\. Changes made here are kept /,
    );
    expect(turnedAwayNotice('review', NO_DOC_MEMORY)).toMatch(/for the comments of this project right now\./);
  });

  it('has a sentence for a close that came without a reason, and passes on a reason it does not know', () => {
    expect(turnedAwayNotice('project', null)).toMatch(
      /^A change made here is larger than the server takes in one piece\. Changes made here are kept /,
    );
    expect(turnedAwayNotice('project', 'the disk is full')).toMatch(
      /^The server did not take what was sent to it: the disk is full\. Changes made here are kept /,
    );
    // The full review document is not a reason this document knows.
    expect(turnedAwayNotice('project', docFullMessage('review'))).toMatch(/^The server did not take /);
  });
});

describe('tooLargeNotice', () => {
  it('names the setting whoever runs the server would raise', () => {
    expect(tooLargeNotice('project')).toBe(
      'This project is larger than this server loads. Whoever runs the server can raise MAX_PROJECT_DOC_BYTES.',
    );
    expect(tooLargeNotice('review')).toBe(
      'The comments of this project are larger than this server loads. Whoever runs the server can raise MAX_REVIEW_DOC_BYTES.',
    );
  });
});

describe('availabilityOf', () => {
  const info: ProjectInfo = { id: 'p', role: 'editor', createdAt: 1, updatedAt: 2 };

  it('reads what the server says of each document', () => {
    const told = { ...info, docs: { project: 'too-large', review: 'busy' } } satisfies ProjectInfo;
    expect(availabilityOf(told, 'project')).toBe('too-large');
    expect(availabilityOf(told, 'review')).toBe('busy');
  });

  it('takes a server that does not say for one that has no place right now', () => {
    expect(availabilityOf(info, 'project')).toBe('ok');
    expect(availabilityOf(info, 'review')).toBe('ok');
  });
});
