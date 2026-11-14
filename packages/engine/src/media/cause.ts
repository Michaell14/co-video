/** A cause is shown beside the sentence it explains: no longer than a line or two of a dialog. */
const MAX_LENGTH = 200;

const ADDRESS = /\b(?:blob:)?[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi;
/**
 * Folders on a disk, down to the last separator: what follows them is a file's own name. Their
 * names can have spaces in them, so where a message names two files the first name goes as well.
 */
const WINDOWS_FOLDERS = /\b[a-z]:\\(?:[^\\"'<>\n]+\\)*/gi;
/** A path begins at a slash that follows no word: `and/or` and `1/2` are not paths. What precedes it is kept. */
const FOLDERS = /(^|[^\w.])\/(?:[^/"'<>\n]+\/)+/g;

/** The last part of an address, without what follows a `?` or a `#`: a file's name, if it has one. */
const lastPart = (address: string): string =>
  address
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/^.*\//, '');

/**
 * What stood in the way, as whoever threw it put it, in one line that can be shown to the person
 * and passed on by them: the name of the error and its message. A message can carry the address a
 * file was read from or where it lies on a disk, which is nobody else's business, so of anything
 * that looks like one only the last part is kept, the file's own name.
 */
export function describeCause(err: unknown): string {
  let said: string;
  if (err instanceof Error || (typeof DOMException !== 'undefined' && err instanceof DOMException)) {
    const { name, message } = err as { name: string; message: string };
    said = !name || name === 'Error' ? message : message ? `${name}: ${message}` : name;
  } else said = typeof err === 'string' ? err : '';
  said = said
    .replace(ADDRESS, lastPart)
    .replace(WINDOWS_FOLDERS, '')
    .replace(FOLDERS, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!said) return 'Unknown error';
  return said.length > MAX_LENGTH ? `${said.slice(0, MAX_LENGTH - 1).trimEnd()}…` : said;
}
