/**
 * Wire protocol between clients and the relay (Cloudflare Durable Object).
 *
 * The relay is deliberately dumb: it knows peers and routes opaque binary
 * payloads. It never parses application data, so the app protocol can evolve
 * without redeploying the relay. See docs/ARCHITECTURE.md#networking.
 *
 * Binary frames
 *   client -> relay: [u8 version][u8 toLen][to: utf8][payload]   (toLen 0 = broadcast)
 *   relay -> client: [u8 version][u8 fromLen][from: utf8][payload]
 * Text frames carry JSON control messages (RelayControl).
 */

export const RELAY_PROTOCOL_VERSION = 1;

/** Max peers in one room. A full WebRTC mesh gets expensive beyond this. */
export const MAX_PEERS_PER_ROOM = 8;

export interface PeerInfo {
  id: string;
  name: string;
}

export type RelayControl =
  | { type: 'welcome'; self: PeerInfo; peers: PeerInfo[] }
  | { type: 'peer-joined'; peer: PeerInfo }
  | { type: 'peer-left'; id: string }
  | { type: 'error'; code: 'room-full' | 'bad-request' | 'replaced'; message: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeAddressed(address: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const addr = encoder.encode(address);
  if (addr.length > 255) throw new Error('address too long');
  const out = new Uint8Array(2 + addr.length + payload.length);
  out[0] = RELAY_PROTOCOL_VERSION;
  out[1] = addr.length;
  out.set(addr, 2);
  out.set(payload, 2 + addr.length);
  return out;
}

function decodeAddressed(frame: Uint8Array): { address: string; payload: Uint8Array } | null {
  if (frame.length < 2 || frame[0] !== RELAY_PROTOCOL_VERSION) return null;
  const len = frame[1] ?? 0;
  if (frame.length < 2 + len) return null;
  return {
    address: decoder.decode(frame.subarray(2, 2 + len)),
    payload: frame.subarray(2 + len),
  };
}

/** Client -> relay. `to` = peer id, or '' to broadcast to everyone else. */
export function encodeOutgoing(to: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return encodeAddressed(to, payload);
}

export function decodeOutgoing(frame: Uint8Array): { to: string; payload: Uint8Array } | null {
  const d = decodeAddressed(frame);
  return d && { to: d.address, payload: d.payload };
}

/** Relay -> client, stamped with the sender id by the relay (clients cannot spoof it). */
export function encodeIncoming(from: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return encodeAddressed(from, payload);
}

export function decodeIncoming(frame: Uint8Array): { from: string; payload: Uint8Array } | null {
  const d = decodeAddressed(frame);
  return d && { from: d.address, payload: d.payload };
}

// ---------------------------------------------------------------------------
// Room codes and ids
// ---------------------------------------------------------------------------

/** No 0/O/1/I/L to keep codes readable when shouted across a room. */
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
const ROOM_CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_RE.test(code);
}

export function randomRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)];
  }
  return code;
}

const PEER_ID_RE = /^[a-z0-9]{6,32}$/;

export function isValidPeerId(id: string): boolean {
  return PEER_ID_RE.test(id);
}

export function sanitizePlayerName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
  return cleaned || 'Player';
}

/** Random lowercase id, suitable for peer ids and object ids. */
export function randomId(length = 12): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}
