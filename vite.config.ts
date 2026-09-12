import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The app shell as a service worker, so a phone that reloads with no network still opens the app.
 * It precaches the shell and nothing else. What a device keeps of the data is the query persister's
 * (src/app/queryPersistence.ts) and the outbox's: they know whose it is and how old it may be, and a
 * worker does not.
 */
const offlineShell = VitePWA({
  // A release waits for a person: src/app/registerServiceWorker.ts offers a reload instead of the new
  // worker taking over on its own, because that reloads the page, and a till mid-payment would lose
  // what the cashier was typing. What was already tapped is in the outbox either way.
  registerType: 'prompt',
  manifest: {
    name: 'POS Admin Dashboard',
    short_name: 'POS',
    description:
      'An offline-first point of sale for a café: the room, the counter, the kitchen and the back office.',
    theme_color: '#2563eb',
    background_color: '#ffffff',
    display: 'standalone',
    icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  },
  // The icon is in public/, which the glob below precaches already; naming it here as well would put
  // it in the precache list twice.
  includeManifestIcons: false,
  workbox: {
    // Everything the build writes and everything it copies out of public/: a cold start with no
    // network asks for all of it, the icon included. Keep public/ to files worth downloading each
    // time a new worker installs.
    globPatterns: ['**/*'],
    // The plugin adds the manifest to the precache itself, with its own revision.
    globIgnores: ['manifest.webmanifest'],
    // Any path that is not a file is one of the faces (/serveur, /caisse, /kitchen, /admin), and the
    // router draws every one of them from index.html.
    navigateFallback: 'index.html',
    // No runtimeCaching, on purpose: a worker that cached API responses would answer with a stale
    // sale, session or table as though the server had just said so.
  },
});

/**
 * The libraries the app is built on, grouped into chunks a browser can keep. They change only when
 * a dependency is upgraded, so a release that touches the app's own code leaves them in the cache
 * rather than making every register download the whole bundle again — which matters on the shop
 * connections this thing is for. React and its renderer stay together, as do the form libraries
 * and the schema they share: splitting a group that initialises in one pass buys nothing and only
 * adds a round trip. Anything not listed here stays in the entry chunk.
 */
const VENDOR_CHUNKS: ReadonlyMap<string, readonly string[]> = new Map([
  ['react', ['react', 'react-dom', 'scheduler', 'react-is']],
  ['router', ['react-router']],
  ['query', ['@tanstack/react-query', '@tanstack/query-core']],
  ['forms', ['zod', 'react-hook-form', '@hookform/resolvers']],
  [
    'ui',
    [
      '@radix-ui',
      'lucide-react',
      'sonner',
      'class-variance-authority',
      'clsx',
      'tailwind-merge',
      'aria-hidden',
      'react-remove-scroll',
      'react-remove-scroll-bar',
      'react-style-singleton',
      'use-callback-ref',
      'use-sidecar',
      'get-nonce',
      'detect-node-es',
    ],
  ],
]);

/** The package a module comes from, or null for the app's own source. */
function packageOf(id: string): string | null {
  const parts = id.replace(/\\/g, '/').split('node_modules/');
  if (parts.length < 2) {
    return null;
  }
  const segments = parts[parts.length - 1].split('/');
  return segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}

function vendorChunk(id: string): string | undefined {
  const name = packageOf(id);
  if (name === null) {
    return undefined;
  }
  for (const [chunk, packages] of VENDOR_CHUNKS) {
    if (packages.some((candidate) => name === candidate || name.startsWith(`${candidate}/`))) {
      return chunk;
    }
  }
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss(), offlineShell],
  resolve: {
    // Root-relative, so the alias resolves nothing itself; tsconfig.json mirrors it in "paths".
    alias: { '@': '/src' },
  },
  build: {
    rollupOptions: {
      output: {
        // Only modules from node_modules are moved; the app's own code stays where Rollup put it.
        manualChunks: (id) => vendorChunk(id),
      },
    },
  },
});
