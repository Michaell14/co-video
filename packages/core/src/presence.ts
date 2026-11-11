/** Presence ("awareness") state every connected client shares with the room. */
import type { ID } from './types';

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

export interface PresenceCursor {
  area: 'timeline' | 'viewer';
  /** Timeline: frame. Viewer: 0…1 across the picture. */
  x: number;
  /** Timeline: track id. Viewer: 0…1 down the picture. */
  y: number | string;
}

export interface PresenceState {
  user: PresenceUser;
  role: Role;
  playhead: number;
  playing: boolean;
  selection: ID[];
  cursor: PresenceCursor | null;
  /** Clips this user is currently dragging / trimming, with their previewed positions. */
  dragging: { id: ID; start: number; duration: number; trackId: ID }[] | null;
  /** Workspace the user is in, e.g. edit / color. */
  page: string;
}

export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';

export const canEdit = (r: Role): boolean => r === 'owner' || r === 'editor';
export const canComment = (r: Role): boolean => r !== 'viewer';

export const USER_COLORS = [
  '#ff5d5d',
  '#ff9f43',
  '#ffd43b',
  '#51cf66',
  '#22d3ee',
  '#4dabf7',
  '#9775fa',
  '#f783ac',
  '#20c997',
  '#fd7e14',
];

const ADJECTIVES = ['Swift', 'Bright', 'Bold', 'Calm', 'Clever', 'Lucky', 'Mellow', 'Nimble', 'Quiet', 'Vivid', 'Witty', 'Golden'];
const ANIMALS = ['Falcon', 'Otter', 'Lynx', 'Heron', 'Panda', 'Fox', 'Koala', 'Orca', 'Finch', 'Gecko', 'Ibex', 'Wren'];

export function randomUserName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a} ${b}`;
}

export function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
