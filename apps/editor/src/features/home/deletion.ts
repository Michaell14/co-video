/**
 * Deleting a shared project for everyone, as far as it is words and rules: who is offered it, and
 * what is said when the server did not do it.
 */
import { ApiError } from '../../session/api';

/** Offered to whoever holds the owner's link. Whether it really is that is for the server to say. */
export { ownsProject } from '../../session/registry';

const UNCHANGED = 'Nothing was changed on this device.';

/**
 * Why a project was not deleted from the server, as a sentence for the person who asked. `err` is
 * what the request ended with: the server's refusal, no answer in time, or no connection. Only a
 * refusal is certain to have left the project where it was. A request that got no answer may
 * have been carried out all the same, and asking again is how to find out: the server answers a
 * second request as it did the first.
 */
export function whyNotDeleted(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403)
      return 'The server did not take the link on this device for the owner’s, and only the owner can delete a project for everyone. Nothing was deleted.';
    if (err.status === 404)
      return 'The server does not have this project, so there was nothing to delete there. You can still delete it from this device.';
    if (err.status === 410)
      return 'The server says that this project has already been deleted. You can still delete it from this device.';
    if (err.status === 429)
      return 'The server has taken as many deletions from this address as it does in an hour. Nothing was deleted: try again later.';
    return `The server could not delete the project (${err.status}). ${UNCHANGED} Try again.`;
  }
  if (err instanceof Error && err.name === 'TimeoutError')
    return `The collaboration server did not answer in time, so the project may or may not be deleted there. ${UNCHANGED} Try again to make sure.`;
  return `The collaboration server could not be reached. ${UNCHANGED} Try again when it can.`;
}
