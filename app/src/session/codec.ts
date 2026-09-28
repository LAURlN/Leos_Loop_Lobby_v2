/**
 * Layer audio wire format.
 *
 *   [0..3]  magic "LLA1"
 *   [4]     codec: 0 = PCM16, 1 = PCM16 + deflate-raw
 *   [5..8]  frame count (u32 LE)
 *   [9..]   body
 *
 * PCM16 at 48 kHz mono is ~96 kB/s before compression. A lossy codec (Opus via
 * WebCodecs) can be added as codec 2 without breaking old clients' decoding
 * of codecs 0/1; see docs/ROADMAP.md.
 */

const MAGIC = [0x4c, 0x4c, 0x41, 0x31]; // "LLA1"
const HEADER = 9;
export const CODEC_PCM16 = 0;
export const CODEC_PCM16_DEFLATE = 1;

const canCompress = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const response = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

export async function encodeLayerAudio(pcm: Float32Array): Promise<Uint8Array> {
  const body = new Uint8Array(pcm.length * 2);
  const view = new DataView(body.buffer);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    view.setInt16(i * 2, Math.round(s * 32767), true);
  }
  const compressed = canCompress() ? await transform(body, new CompressionStream('deflate-raw')) : null;
  const useCompressed = compressed !== null && compressed.length < body.length;
  const payload = useCompressed ? compressed : body;
  const out = new Uint8Array(HEADER + payload.length);
  out.set(MAGIC, 0);
  out[4] = useCompressed ? CODEC_PCM16_DEFLATE : CODEC_PCM16;
  new DataView(out.buffer).setUint32(5, pcm.length, true);
  out.set(payload, HEADER);
  return out;
}

export async function decodeLayerAudio(bytes: Uint8Array): Promise<Float32Array> {
  if (bytes.length < HEADER || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error('Not layer audio');
  const codec = bytes[4];
  const frames = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5, true);
  let body = bytes.subarray(HEADER);
  if (codec === CODEC_PCM16_DEFLATE) body = await transform(body, new DecompressionStream('deflate-raw'));
  else if (codec !== CODEC_PCM16) throw new Error(`Unsupported layer codec ${codec}`);
  if (body.length < frames * 2) throw new Error('Truncated layer audio');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = view.getInt16(i * 2, true) / 32767;
  return out;
}
