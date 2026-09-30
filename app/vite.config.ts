import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Build-time configuration (see README.md "Deploy"):
// - BASE_PATH       URL path the app is served from, e.g. "/Leos_Loop_Lobby_v2/" on GitHub Pages
// - VITE_RELAY_URL  wss:// URL of the Cloudflare relay; unset = same origin (dev proxy below)
// - HTTPS=1         self-signed https dev server, so phones on the LAN may use the mic
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [svelte(), ...(process.env.HTTPS ? [basicSsl()] : [])],
  server: {
    port: 5173,
    // Hosts the dev server answers to, besides localhost. `.e2b.app` covers the
    // sandbox live-preview proxy (https://<port>-<id>.e2b.app); set
    // ALLOWED_DEV_HOSTS="host1,host2" for anything else (e.g. a LAN name).
    allowedHosts: (process.env.ALLOWED_DEV_HOSTS ?? '.e2b.app').split(',').filter(Boolean),
    // In development the relay (`npm run dev:relay`) is reached through Vite,
    // so http/https and phone-on-LAN setups all work with one URL.
    proxy: { '/room': { target: 'http://127.0.0.1:8787', ws: true } },
  },
  build: { target: 'es2022' },
});
