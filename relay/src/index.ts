/**
 * Cloudflare Worker entry point.
 *
 * - `GET /room/:CODE?peer=<id>&name=<name>` (WebSocket upgrade) -> Room Durable Object
 * - `GET /health` -> "ok"
 *
 * The app is hosted separately (GitHub Pages). The relay stores nothing:
 * rooms only live while someone is connected.
 */
import { isValidPeerId, isValidRoomCode, normalizeRoomCode } from '@lll/shared';

export { Room } from './room';

export interface Env {
  ROOMS: DurableObjectNamespace;
  /** Comma-separated allowed web origins; empty = allow all. Protects the free quota. */
  ALLOWED_ORIGINS?: string;
}

export function isOriginAllowed(origin: string | null, allowList: string | undefined): boolean {
  const allowed = (allowList ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (allowed.length === 0) return true;
  return origin !== null && allowed.includes(origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/room\/([^/]+)$/.exec(url.pathname);
    if (match?.[1]) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      if (!isOriginAllowed(request.headers.get('Origin'), env.ALLOWED_ORIGINS)) {
        return new Response('Origin not allowed', { status: 403 });
      }
      const code = normalizeRoomCode(decodeURIComponent(match[1]));
      const peer = url.searchParams.get('peer') ?? '';
      if (!isValidRoomCode(code) || !isValidPeerId(peer)) {
        return new Response('Invalid room code or peer id', { status: 400 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    if (url.pathname === '/health') return new Response('ok');
    return new Response("Leo's Loop Lobby relay. The app lives on GitHub Pages.", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
