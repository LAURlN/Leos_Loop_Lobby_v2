/**
 * One Durable Object per room code. A dumb, hibernation-friendly router:
 * - knows which peers are connected (WebSocket attachment + tag = peer id)
 * - forwards binary frames to one peer or to everyone else, stamping the sender
 * - announces joins/leaves as JSON control messages
 *
 * It never parses application payloads and keeps no storage, so the room
 * disappears as soon as the last peer leaves. Keep it this way: all session
 * state lives in the clients' CRDT (see docs/ARCHITECTURE.md).
 */
import { DurableObject } from 'cloudflare:workers';
import {
  MAX_PEERS_PER_ROOM,
  decodeOutgoing,
  encodeIncoming,
  sanitizePlayerName,
  type PeerInfo,
  type RelayControl,
} from '@lll/shared';
import type { Env } from './index';

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object (no duration cost).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const self: PeerInfo = {
      id: url.searchParams.get('peer') ?? '',
      name: sanitizePlayerName(url.searchParams.get('name') ?? ''),
    };

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // A reconnect with the same peer id replaces the stale socket.
    for (const old of this.ctx.getWebSockets(self.id)) {
      send(old, { type: 'error', code: 'replaced', message: 'Connected from another tab or reconnected.' });
      try {
        old.close(4001, 'replaced');
      } catch {
        /* already closed */
      }
    }

    const others = this.peers().filter((p) => p.id !== self.id);
    this.ctx.acceptWebSocket(server, [self.id]);
    server.serializeAttachment(self);

    if (others.length >= MAX_PEERS_PER_ROOM) {
      send(server, { type: 'error', code: 'room-full', message: `Rooms are limited to ${MAX_PEERS_PER_ROOM} players.` });
      server.close(4002, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    send(server, { type: 'welcome', self, peers: others });
    this.broadcastControl({ type: 'peer-joined', peer: self }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === 'string') return; // no client text messages yet
    const from = peerOf(ws);
    const decoded = decodeOutgoing(new Uint8Array(message));
    if (!from || !decoded) return;
    const frame = encodeIncoming(from.id, decoded.payload);
    const targets = decoded.to ? this.ctx.getWebSockets(decoded.to) : this.ctx.getWebSockets();
    for (const target of targets) {
      if (target === ws) continue;
      try {
        target.send(frame);
      } catch {
        /* socket is closing; its close handler cleans up */
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.handleGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.handleGone(ws);
  }

  private handleGone(ws: WebSocket): void {
    const peer = peerOf(ws);
    if (!peer) return;
    const stillThere = this.ctx.getWebSockets(peer.id).some((s) => s !== ws);
    if (!stillThere) this.broadcastControl({ type: 'peer-left', id: peer.id }, ws);
  }

  private peers(): PeerInfo[] {
    const byId = new Map<string, PeerInfo>();
    for (const ws of this.ctx.getWebSockets()) {
      const p = peerOf(ws);
      if (p) byId.set(p.id, p);
    }
    return [...byId.values()];
  }

  private broadcastControl(message: RelayControl, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except) send(ws, message);
    }
  }
}

function peerOf(ws: WebSocket): PeerInfo | null {
  return (ws.deserializeAttachment() as PeerInfo | null) ?? null;
}

function send(ws: WebSocket, message: RelayControl): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* ignore */
  }
}
