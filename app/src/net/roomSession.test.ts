import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { addLayer, createTrack, setTrackMix } from '../session/actions';
import { LayerAudioStore } from '../session/layerAudio';
import { readSnapshot } from '../session/schema';
import { MemoryHub } from './memoryTransport';
import { RoomSession, type Presence } from './roomSession';

const settle = async (ms = 50) => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, ms / 20));
};

function client(hub: MemoryHub, id: string) {
  const doc = new Y.Doc();
  const store = new LayerAudioStore();
  let presence: Presence[] = [];
  const room = new RoomSession(doc, store, hub.connect({ id, name: id }), {
    status: () => {},
    peers: () => {},
    presence: (p) => (presence = p),
  });
  return { doc, store, room, presence: () => presence };
}

describe('RoomSession over a relay-like transport', () => {
  it('a late joiner receives the full session and the layer audio', async () => {
    const hub = new MemoryHub();
    const a = client(hub, 'aaaaaa');
    await settle();
    const track = createTrack(a.doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'aaaaaa' });
    const audio = new Float32Array(48000 * 3).map((_, i) => Math.sin(i / 10) * 0.5);
    a.store.put('layer1', audio);
    addLayer(a.doc, { id: 'layer1', trackId: track, author: 'aaaaaa', authorName: 'A', offset: 0, frames: audio.length, length48: audio.length });

    const b = client(hub, 'bbbbbb');
    await settle(200);
    expect(readSnapshot(b.doc)).toEqual(readSnapshot(a.doc));
    const received = b.store.get('layer1');
    expect(received?.length).toBe(audio.length);
    expect(Math.abs((received?.[1234] ?? 0) - (audio[1234] ?? 0))).toBeLessThan(1e-3);
  });

  it('live edits propagate both ways and presence is shared', async () => {
    const hub = new MemoryHub();
    const a = client(hub, 'aaaaaa');
    const b = client(hub, 'bbbbbb');
    await settle();
    const track = createTrack(a.doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'aaaaaa' });
    await settle();
    setTrackMix(b.doc, track, { volume: 0.25 });
    b.room.setPresence({ peerId: 'bbbbbb', name: 'B', recordingTrackId: track });
    await settle();
    expect(readSnapshot(a.doc).tracks[0]?.volume).toBe(0.25);
    expect(a.presence().find((p) => p.peerId === 'bbbbbb')?.recordingTrackId).toBe(track);

    b.room.close();
    await settle();
    expect(a.presence().some((p) => p.peerId === 'bbbbbb')).toBe(false);
  });

  it('edits made while alone survive and merge when others join', async () => {
    const hub = new MemoryHub();
    const a = client(hub, 'aaaaaa');
    const b = client(hub, 'bbbbbb');
    await settle();
    b.room.close();
    await settle();
    createTrack(a.doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'aaaaaa' });
    // B comes back with a new connection but keeps its document.
    const b2 = new RoomSession(b.doc, b.store, hub.connect({ id: 'bbbbbb', name: 'B' }), {
      status: () => {},
      peers: () => {},
      presence: () => {},
    });
    await settle();
    expect(readSnapshot(b.doc).tracks).toHaveLength(1);
    b2.close();
  });
});
