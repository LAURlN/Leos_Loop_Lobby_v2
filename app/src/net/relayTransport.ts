/** Transport over the Cloudflare relay (WebSocket), with automatic reconnect. */
import { decodeIncoming, encodeOutgoing, type RelayControl } from '@lll/shared';
import type { Transport, TransportHandlers } from './transport';

const PING_INTERVAL_MS = 20_000;
const MAX_BACKOFF_MS = 10_000;

export interface RelayOptions {
  baseUrl: string;
  roomCode: string;
  selfId: string;
  name: string;
}

export class RelayTransport implements Transport {
  readonly selfId: string;
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private ping: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: RelayOptions,
    private readonly handlers: TransportHandlers,
  ) {
    this.selfId = options.selfId;
    this.connect();
  }

  private url(): string {
    const { baseUrl, roomCode, selfId, name } = this.options;
    const params = new URLSearchParams({ peer: selfId, name });
    return `${baseUrl.replace(/\/$/, '')}/room/${encodeURIComponent(roomCode)}?${params}`;
  }

  private connect(): void {
    this.handlers.status(this.attempt === 0 ? { state: 'connecting' } : { state: 'reconnecting', attempt: this.attempt });
    const ws = new WebSocket(this.url());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        if (event.data !== 'pong') this.onControl(JSON.parse(event.data) as RelayControl);
        return;
      }
      const frame = decodeIncoming(new Uint8Array(event.data as ArrayBuffer));
      if (frame) this.handlers.message(frame.from, frame.payload);
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.ws === ws) this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows and handles reconnecting */
    };
  }

  private onControl(msg: RelayControl): void {
    switch (msg.type) {
      case 'welcome':
        this.attempt = 0;
        clearInterval(this.ping);
        this.ping = setInterval(() => this.ws?.readyState === WebSocket.OPEN && this.ws.send('ping'), PING_INTERVAL_MS);
        this.handlers.status({ state: 'connected' });
        this.handlers.peersReset(msg.peers);
        break;
      case 'peer-joined':
        this.handlers.peerJoined(msg.peer);
        break;
      case 'peer-left':
        this.handlers.peerLeft(msg.id);
        break;
      case 'error':
        if (msg.code === 'room-full' || msg.code === 'replaced') {
          this.closed = true;
          this.handlers.status({ state: 'failed', reason: msg.message });
        }
        break;
    }
  }

  private scheduleReconnect(): void {
    this.attempt++;
    this.handlers.status({ state: 'reconnecting', attempt: this.attempt });
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.attempt - 1));
    this.retry = setTimeout(() => !this.closed && this.connect(), delay);
  }

  send(payload: Uint8Array, to = ''): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeOutgoing(to, payload));
  }

  close(): void {
    this.closed = true;
    clearInterval(this.ping);
    clearTimeout(this.retry);
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.handlers.status({ state: 'closed' });
  }
}
