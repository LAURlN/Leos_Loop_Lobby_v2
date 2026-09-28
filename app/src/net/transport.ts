/**
 * A Transport moves opaque binary payloads between peers of one room.
 * RoomSession only talks to this interface, so the relay (today) and WebRTC
 * peer-to-peer links (next, see docs/ROADMAP.md) are interchangeable or can
 * be combined by a composite transport.
 */
import type { PeerInfo } from '@lll/shared';

export type TransportStatus =
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'failed'; reason: string }
  | { state: 'closed' };

export interface TransportHandlers {
  message(from: string, payload: Uint8Array): void;
  /** The full peer list is (re)known, e.g. after (re)connecting. Resync with everyone. */
  peersReset(peers: PeerInfo[]): void;
  peerJoined(peer: PeerInfo): void;
  peerLeft(peerId: string): void;
  status(status: TransportStatus): void;
}

export interface Transport {
  readonly selfId: string;
  /** Sends to one peer, or to everyone else if `to` is omitted. Best effort. */
  send(payload: Uint8Array, to?: string): void;
  close(): void;
}

export type TransportFactory = (handlers: TransportHandlers) => Transport;
