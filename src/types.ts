import formats from './photo-formats.json';

export type Seat = string;
export const pairKey = (a: string, b: string) => [a, b].sort().join(':');
export const filterNames = {
  exposure: 'Exposure', brightness: 'Brightness', contrast: 'Contrast',
  saturation: 'Saturation', temperature: 'Temperature', tint: 'Tint',
};
export type FilterKey = keyof typeof filterNames;
export type Filters = Record<FilterKey, number>;
export const neutral: Filters = { exposure: 0, brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 };
export type Ratio = keyof typeof formats.ratios;
export type Strip = keyof typeof formats.strips;
export type Person = { x: number; y: number; scale: number };
export const fullFrame: Person = { x: 0.5, y: 0.5, scale: 1 };
export type Layout = {
  revision: number; background: string; frame: string;
  ratio: Ratio; strip: Strip; count: number; people: Record<Seat, Person>; order: Seat[];
};
export type Session = { roomId: string; seat: Seat; credential: string; invite: string; albumId: string; albumToken: string };
export type Slot = { id: string; digest: string };
export type Presence = { online: boolean; id?: string; camera: boolean; links: string[] };
export type RoomState = {
  layout: Layout; slots: (Slot | null)[]; presence: Record<Seat, Presence>;
  resets: Record<string, string>; busy: 'capture' | 'export' | null;
};
export function linkId(state: RoomState, a: string, b: string) {
  const pair = pairKey(a, b);
  return state.resets[pair] ?? pair;
}

export function canTakePhoto(state: RoomState, seat: Seat) {
  const local = state.presence[seat];
  if (!local?.camera || !local.id) return false;
  const localId = local.id;
  return Object.entries(state.presence).every(([member, peer]) => {
    if (member === seat || !peer.camera || !peer.id) return true;
    const link = linkId(state, localId, peer.id);
    return local.links.includes(link) && peer.links.includes(link);
  });
}
export type Capture = {
  captureId: string; slot: number; compositor: Seat; members: Seat[]; layout: Layout;
  filters: Record<Seat, Filters>; mirrors: Record<Seat, boolean>;
};
export type AlbumFile = { id: string; position: number; bytes: number };
export type Version = { id: string; version: number; stored: number; expires: number; slots: number; files: AlbumFile[] };

export async function api<T>(path: string, credential?: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (credential) headers.set('Authorization', `Bearer ${credential}`);
  const response = await fetch(`/api${path}`, { ...init, headers, cache: 'no-store' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(error.error ?? 'Permintaan gagal. Coba lagi.');
  }
  return response.json();
}

export const inviteLink = (session: Session) => `${location.origin}/room/${session.roomId}#${session.invite}`;
export const albumLink = (session: Session) => `/album/${session.albumId}#${session.albumToken}`;
export const sessionKey = (id: string) => `photobox:session:${id}`;
export const mirrorKey = (id: string) => `photobox:mirror:${id}`;
