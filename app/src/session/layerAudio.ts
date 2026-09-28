/**
 * Immutable per-layer audio (canonical rate, mono). Lives next to the CRDT,
 * keyed by layer id. Encoded bytes are what travels over the network.
 */
import { decodeLayerAudio, encodeLayerAudio } from './codec';

export class LayerAudioStore {
  private pcm = new Map<string, Float32Array>();
  private encoded = new Map<string, Promise<Uint8Array>>();
  private listeners = new Set<(layerId: string) => void>();

  has(layerId: string): boolean {
    return this.pcm.has(layerId);
  }

  get(layerId: string): Float32Array | undefined {
    return this.pcm.get(layerId);
  }

  put(layerId: string, data: Float32Array): void {
    if (this.pcm.has(layerId)) return;
    this.pcm.set(layerId, data);
    for (const l of this.listeners) l(layerId);
  }

  async putEncoded(layerId: string, bytes: Uint8Array): Promise<void> {
    if (this.pcm.has(layerId)) return;
    const data = await decodeLayerAudio(bytes);
    this.encoded.set(layerId, Promise.resolve(bytes));
    this.put(layerId, data);
  }

  /** Encoded bytes for sending; cached. */
  getEncoded(layerId: string): Promise<Uint8Array> | undefined {
    const cached = this.encoded.get(layerId);
    if (cached) return cached;
    const data = this.pcm.get(layerId);
    if (!data) return undefined;
    const promise = encodeLayerAudio(data);
    this.encoded.set(layerId, promise);
    return promise;
  }

  /** Frees audio of layers that were removed from the session. */
  forget(layerIds: Iterable<string>): void {
    for (const id of layerIds) {
      this.pcm.delete(id);
      this.encoded.delete(id);
    }
  }

  clear(): void {
    this.pcm.clear();
    this.encoded.clear();
  }

  onAdded(listener: (layerId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
