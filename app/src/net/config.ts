/**
 * Where the relay lives. Production builds get VITE_RELAY_URL (the Cloudflare
 * worker); in development Vite proxies `/room` to `wrangler dev`, so the
 * relay is on the page's own origin.
 */
export function relayBaseUrl(): string {
  const configured = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (configured) return configured;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}`;
}

/** Link that opens the app directly in a room. */
export function roomLink(code: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  return url.toString();
}
