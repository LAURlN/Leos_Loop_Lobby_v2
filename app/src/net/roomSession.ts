/**
 * Binds a session document to a room over any Transport:
 * - Yjs document sync (y-protocols/sync): step1/step2 with every (re)joined peer,
 *   then incremental updates broadcast to everyone
 * - presence via y-protocols/awareness (names, who is recording where)
 * - layer audio via BlobExchange
 *
 * Payload = [varuint channel][channel data]. Unknown channels are ignored, so
 * new channels can be added without breaking older clients.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';
import type { PeerInfo } from '@lll/shared';
import type { LayerAudioStore } from '../session/layerAudio';
import { readSnapshot } from '../session/schema';
import { BlobExchange } from './blobExchange';
import type { Transport, TransportFactory, TransportStatus } from './transport';

const CHANNEL_SYNC = 0;
const CHANNEL_AWARENESS = 1;
const CHANNEL_BLOB = 2;

/** What each client publishes about itself (awareness state). */
export interface Presence {
  peerId: string;
  name: string;
  recordingTrackId: string | null;
}

export interface RoomCallbacks {
  status(status: TransportStatus): void;
  peers(peers: PeerInfo[]): void;
  presence(states: Presence[]): void;
}

export class RoomSession {
  readonly awareness: awarenessProtocol.Awareness;
  private readonly transport: Transport;
  private readonly blobs: BlobExchange;
  private readonly peers = new Map<string, PeerInfo>();
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwarenessUpdate: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void;
  private readonly onAwarenessChange: () => void;

  constructor(
    private readonly doc: Y.Doc,
    store: LayerAudioStore,
    connect: TransportFactory,
    private readonly callbacks: RoomCallbacks,
  ) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.blobs = new BlobExchange(
      store,
      (payload, to) => this.transport.send(payload, to),
      () => [...this.peers.keys()],
      CHANNEL_BLOB,
    );
    this.transport = connect({
      message: (from, payload) => this.receive(from, payload),
      peersReset: (list) => {
        this.peers.clear();
        for (const p of list) this.peers.set(p.id, p);
        this.emitPeers();
        for (const p of list) this.greet(p.id);
        this.blobs.retryAll();
      },
      peerJoined: (peer) => {
        this.peers.set(peer.id, peer);
        this.emitPeers();
        this.greet(peer.id);
        this.blobs.retryAll();
      },
      peerLeft: (id) => {
        this.peers.delete(id);
        this.emitPeers();
        const gone = [...this.awareness.getStates().entries()]
          .filter(([, s]) => (s as Partial<Presence>).peerId === id)
          .map(([clientId]) => clientId);
        awarenessProtocol.removeAwarenessStates(this.awareness, gone, this);
      },
      status: (s) => callbacks.status(s),
    });

    this.onDocUpdate = (update, origin) => {
      if (origin === this) return; // came from the network
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, CHANNEL_SYNC);
      syncProtocol.writeUpdate(e, update);
      this.transport.send(encoding.toUint8Array(e));
      this.requestMissingAudio();
    };
    doc.on('update', this.onDocUpdate);

    this.onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === this) return;
      const changed = [...added, ...updated, ...removed];
      this.transport.send(this.awarenessMessage(changed));
    };
    this.awareness.on('update', this.onAwarenessUpdate);
    this.onAwarenessChange = () => callbacks.presence(this.presence());
    this.awareness.on('change', this.onAwarenessChange);
  }

  get selfId(): string {
    return this.transport.selfId;
  }

  setPresence(presence: Presence): void {
    this.awareness.setLocalState(presence);
  }

  presence(): Presence[] {
    return [...this.awareness.getStates().values()].filter((s): s is Presence => typeof (s as Presence).peerId === 'string');
  }

  /** Start syncing with a (new) peer. */
  private greet(peerId: string): void {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, CHANNEL_SYNC);
    syncProtocol.writeSyncStep1(e, this.doc);
    this.transport.send(encoding.toUint8Array(e), peerId);
    this.transport.send(this.awarenessMessage([this.doc.clientID]), peerId);
  }

  private awarenessMessage(clients: number[]): Uint8Array {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, CHANNEL_AWARENESS);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    return encoding.toUint8Array(e);
  }

  private receive(from: string, payload: Uint8Array): void {
    try {
      const d = decoding.createDecoder(payload);
      const channel = decoding.readVarUint(d);
      switch (channel) {
        case CHANNEL_SYNC: {
          const e = encoding.createEncoder();
          encoding.writeVarUint(e, CHANNEL_SYNC);
          syncProtocol.readSyncMessage(d, e, this.doc, this);
          if (encoding.length(e) > 1) this.transport.send(encoding.toUint8Array(e), from);
          this.requestMissingAudio();
          break;
        }
        case CHANNEL_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), this);
          break;
        case CHANNEL_BLOB:
          this.blobs.handle(from, d);
          break;
        default:
          break; // newer client feature; ignore
      }
    } catch (err) {
      console.warn('Dropping malformed message from', from, err);
    }
  }

  private requestMissingAudio(): void {
    const layers = readSnapshot(this.doc).tracks.flatMap((t) => t.layers.filter((l) => !l.hidden));
    this.blobs.want(layers.map((l) => ({ id: l.id, author: l.author })));
  }

  private emitPeers(): void {
    this.callbacks.peers([...this.peers.values()]);
  }

  close(): void {
    this.doc.off('update', this.onDocUpdate);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
    this.awareness.off('update', this.onAwarenessUpdate);
    this.awareness.off('change', this.onAwarenessChange);
    this.awareness.destroy();
    this.blobs.dispose();
    this.transport.close();
  }
}
