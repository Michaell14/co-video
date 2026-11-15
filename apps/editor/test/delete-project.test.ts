import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownsProject, whyNotDeleted } from '../src/features/home/deletion';
import { ApiError } from '../src/session/api';

/** A link as the server signs it, as far as the client reads it: the payload names the role. */
const link = (role: string): string => `${btoa(JSON.stringify({ p: 'project', r: role, iat: 1 }))}.signature`;

describe('who is offered to delete a project for everyone', () => {
  it('is whoever holds a link the server confirmed as the owner’s', () => {
    expect(ownsProject({ token: link('owner'), role: 'owner' })).toBe(true);
    for (const role of ['editor', 'commenter', 'viewer'] as const) {
      expect(ownsProject({ token: link(role), role })).toBe(false);
    }
  });

  it('goes by what the server said, not by what the link says of itself', () => {
    expect(ownsProject({ token: link('owner'), role: 'viewer' })).toBe(false);
  });

  it('reads the role from the link of an entry from before the role was kept', () => {
    expect(ownsProject({ token: link('owner') })).toBe(true);
    expect(ownsProject({ token: link('editor') })).toBe(false);
    expect(ownsProject({ token: 'not a link' })).toBe(false);
  });

  it('is nobody for a project that is not shared', () => {
    expect(ownsProject({ token: null })).toBe(false);
    expect(ownsProject({ token: null, role: 'owner' })).toBe(false);
  });
});

describe('why a project was not deleted from the server', () => {
  const refused = (status: number): string => whyNotDeleted(new ApiError('said the server', status, true));

  it('says that only the owner can, when the server does not take the link for the owner’s', () => {
    expect(refused(403)).toMatch(/only the owner can delete a project for everyone\. Nothing was deleted\./);
    expect(refused(401)).toBe(refused(403));
  });

  it('says so when there was nothing on the server to delete', () => {
    expect(refused(404)).toMatch(/does not have this project/);
    expect(refused(410)).toMatch(/has already been deleted/);
    for (const status of [404, 410])
      expect(refused(status)).toMatch(/You can still delete it from this device\./);
  });

  it('asks for patience when the server has taken too many deletions', () => {
    expect(refused(429)).toMatch(/Nothing was deleted: try again later\./);
  });

  it('gives the status of an answer it has no words for, from the server or from whatever stands before it', () => {
    expect(refused(500)).toBe(
      'The server could not delete the project (500). Nothing was changed on this device. Try again.',
    );
    expect(whyNotDeleted(new ApiError('Request failed (502)', 502, false))).toMatch(/\(502\)/);
  });

  it('does not claim that nothing was deleted when no answer came', () => {
    const late = whyNotDeleted(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(late).toMatch(/did not answer in time, so the project may or may not be deleted there/);
    expect(late).toMatch(/Nothing was changed on this device\. Try again to make sure\./);
    const offline = whyNotDeleted(new TypeError('Failed to fetch'));
    expect(offline).toMatch(/could not be reached\. Nothing was changed on this device\./);
    expect(offline).not.toMatch(/Nothing was deleted/);
  });
});

describe('deleting a project from this device', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes its entry, its databases and the lane heights kept for it, and nothing of another project', async () => {
    const data = new Map<string, string>([
      [
        'tandem.projects.v1',
        JSON.stringify([
          { id: 'gone', name: 'Gone', token: link('viewer'), role: 'viewer' },
          { id: 'stays', name: 'Stays', token: null },
        ]),
      ],
      [
        'tandem.ui.v1',
        JSON.stringify({ snapping: false, laneHeights: { gone: { v1: 90 }, stays: { v1: 40 } } }),
      ],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    });
    const databases: string[] = [];
    vi.stubGlobal('indexedDB', {
      deleteDatabase: (name: string) => {
        databases.push(name);
        const request: { onsuccess?: () => void } = {};
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    });
    vi.resetModules();
    const { deleteLocalProject } = await import('../src/session/projects');
    const { useUI } = await import('../src/state/ui');
    expect(useUI.getState().laneHeights).toEqual({ gone: { v1: 90 }, stays: { v1: 40 } });

    await deleteLocalProject('gone');
    const listed: { id: string }[] = JSON.parse(data.get('tandem.projects.v1')!);
    expect(listed.map((entry) => entry.id)).toEqual(['stays']);
    expect(databases).toEqual(['tandem:gone:project', 'tandem:gone:review']);
    expect(JSON.parse(data.get('tandem.ui.v1')!)).toEqual({
      snapping: false,
      laneHeights: { stays: { v1: 40 } },
    });
    expect(useUI.getState().laneHeights).toEqual({ stays: { v1: 40 } });
  });
});
