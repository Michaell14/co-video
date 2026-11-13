/**
 * Why a shared project is not reaching the server, in words for the person at the editor.
 *
 * The server says it in two places. A connection it ends over what was sent to it (close code
 * 1009) gets the reason as an `error` first; a connection it will not open at all is refused
 * without a word a browser could read, and `GET /api/projects/:id` says what stands in the way.
 */
import { NO_DOC_MEMORY, docFullMessage, type DocAvailability, type DocKind, type ProjectInfo } from '@tandem/core';

/** What is kept here and not there, for each document. */
const KEPT: Record<DocKind, string> = {
  project: 'Changes made here are kept on this device but are not being saved to the server.',
  review: 'Comments made here are kept on this device but are not being saved to the server.',
};

const FULL: Record<DocKind, string> = {
  project: 'This project has reached the size the server allows.',
  review: 'The comments of this project have reached the size the server allows.',
};

const NO_MEMORY: Record<DocKind, string> = {
  project: 'The server has no memory to spare for this project right now.',
  review: 'The server has no memory to spare for the comments of this project right now.',
};

const ONE_MESSAGE: Record<DocKind, string> = {
  project: 'A change made here is larger than the server takes in one piece.',
  review: 'A comment made here is larger than the server takes in one piece.',
};

/** The limit whoever runs the server would raise, by document. */
const LIMIT_SETTING: Record<DocKind, string> = {
  project: 'MAX_PROJECT_DOC_BYTES',
  review: 'MAX_REVIEW_DOC_BYTES',
};

/**
 * The notice for a connection the server ended over what this client sent. `said` is the reason
 * it gave in its own words, or `null`: a message over the size it reads is cut off without one.
 */
export function turnedAwayNotice(kind: DocKind, said: string | null): string {
  let what: string;
  if (said === null) what = ONE_MESSAGE[kind];
  else if (said === docFullMessage(kind)) what = FULL[kind];
  else if (said === NO_DOC_MEMORY) what = NO_MEMORY[kind];
  else what = `The server did not take what was sent to it: ${said}.`;
  return `${what} ${KEPT[kind]}`;
}

/** The notice for a document the server holds more of than it loads. */
export function tooLargeNotice(kind: DocKind): string {
  const what = kind === 'project' ? 'This project is' : 'The comments of this project are';
  return `${what} larger than this server loads. Whoever runs the server can raise ${LIMIT_SETTING[kind]}.`;
}

/**
 * What the server's answer about a project says of a document it refuses connections to. A server
 * from before the answer had the field says nothing, which reads as `ok`: the link is good and
 * there is no place right now.
 */
export const availabilityOf = (info: ProjectInfo, kind: DocKind): DocAvailability => info.docs?.[kind] ?? 'ok';
