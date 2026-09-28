/**
 * Transfers layer audio between peers. Layer metadata arrives via the CRDT;
 * whoever is missing the audio asks the layer's author first, then any other
 * peer. Audio is immutable, so any copy is as good as the original.
 *
 * Messages (after the channel byte):
 *   WANT    [0][layerId]
 *   CHUNK   [1][layerId][index][total][bytes]
 *   MISSING [2][layerId]
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { LayerAudioStore } from '../session/layerAudio';

const WANT = 0;
const CHUNK = 1;
const MISSING = 2;
/** Small enough for WebRTC data channels later. */
const CHUNK_BYTES = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface Pending {
  asked: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  parts: Map<number, Uint8Array>;
  total: number;
}

export class BlobExchange {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly store: LayerAudioStore,
    private readonly send: (payload: Uint8Array, to?: string) => void,
    private readonly peers: () => string[],
    private readonly channel: number,
  ) {}

  /** Requests every missing layer. `author` is the preferred source. */
  want(layers: Array<{ id: string; author: string }>): void {
    for (const layer of layers) {
      if (this.store.has(layer.id) || this.pending.has(layer.id)) continue;
      const entry: Pending = { asked: new Set(), timer: setTimeout(() => {}, 0), parts: new Map(), total: 0 };
      this.pending.set(layer.id, entry);
      this.askNext(layer.id, layer.author);
    }
  }

  /** Peers changed: retry stalled requests right away. */
  retryAll(): void {
    for (const [id, p] of this.pending) {
      if (p.parts.size === 0) {
        p.asked.clear();
        this.askNext(id);
      }
    }
  }

  private askNext(layerId: string, preferred?: string): void {
    const p = this.pending.get(layerId);
    if (!p) return;
    clearTimeout(p.timer);
    const candidates = this.peers().filter((id) => !p.asked.has(id));
    const target = preferred && candidates.includes(preferred) ? preferred : candidates[0];
    if (!target) {
      // Nobody (left) to ask; try again when peers change or after a while.
      p.asked.clear();
      p.timer = setTimeout(() => this.askNext(layerId), REQUEST_TIMEOUT_MS);
      return;
    }
    p.asked.add(target);
    p.parts.clear();
    p.timer = setTimeout(() => this.askNext(layerId), REQUEST_TIMEOUT_MS);
    this.send(this.message(WANT, layerId), target);
  }

  private message(kind: number, layerId: string, write?: (e: encoding.Encoder) => void): Uint8Array {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, this.channel);
    encoding.writeVarUint(e, kind);
    encoding.writeVarString(e, layerId);
    write?.(e);
    return encoding.toUint8Array(e);
  }

  handle(from: string, d: decoding.Decoder): void {
    const kind = decoding.readVarUint(d);
    const layerId = decoding.readVarString(d);
    if (kind === WANT) void this.respond(from, layerId);
    else if (kind === MISSING) this.askNext(layerId);
    else if (kind === CHUNK) {
      const index = decoding.readVarUint(d);
      const total = decoding.readVarUint(d);
      const bytes = decoding.readVarUint8Array(d);
      this.receiveChunk(layerId, index, total, bytes);
    }
  }

  private async respond(to: string, layerId: string): Promise<void> {
    const bytes = await this.store.getEncoded(layerId);
    if (!bytes) {
      this.send(this.message(MISSING, layerId), to);
      return;
    }
    const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    for (let i = 0; i < total; i++) {
      const part = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      this.send(
        this.message(CHUNK, layerId, (e) => {
          encoding.writeVarUint(e, i);
          encoding.writeVarUint(e, total);
          encoding.writeVarUint8Array(e, part);
        }),
        to,
      );
    }
  }

  private receiveChunk(layerId: string, index: number, total: number, bytes: Uint8Array): void {
    const p = this.pending.get(layerId);
    if (!p || this.store.has(layerId)) return;
    p.total = total;
    p.parts.set(index, bytes.slice());
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.askNext(layerId), REQUEST_TIMEOUT_MS);
    if (p.parts.size < total) return;
    clearTimeout(p.timer);
    this.pending.delete(layerId);
    const size = [...p.parts.values()].reduce((n, b) => n + b.length, 0);
    const all = new Uint8Array(size);
    let offset = 0;
    for (let i = 0; i < total; i++) {
      const part = p.parts.get(i)!;
      all.set(part, offset);
      offset += part.length;
    }
    this.store.putEncoded(layerId, all).catch(() => {
      // Corrupt transfer: ask someone else.
      this.want([{ id: layerId, author: '' }]);
    });
  }

  dispose(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
