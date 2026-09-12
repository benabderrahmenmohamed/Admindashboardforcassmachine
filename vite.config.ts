import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** A short, stable id for a list of file names: the service worker's cache changes with the build. */
function buildId(files: readonly string[]): string {
  let hash = 5381;
  for (const character of files.join('\n')) {
    hash = ((hash * 33) ^ character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function replaceOnce(code: string, pattern: RegExp, value: string): string {
  if (!pattern.test(code)) {
    throw new Error(`The service worker has no ${pattern.source} to fill in.`);
  }
  return code.replace(pattern, value);
}

/**
 * What Vite copies out of public/, as the paths those files take next to the bundle. Rollup never
 * sees them, so they have to be listed from disk: anything the app asks for on a cold offline load
 * — the icon among them — would otherwise go to the network and fail. Keep public/ to files worth
 * precaching; every one of them is downloaded when the worker installs.
 */
function copiedPublicFiles(publicDir: string): readonly string[] {
  if (publicDir === '' || !existsSync(publicDir)) {
    return [];
  }
  // The encoding is spelled out so this reads back file names rather than buffers.
  return readdirSync(publicDir, { encoding: 'utf8', recursive: true })
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((name) => statSync(join(publicDir, name)).isFile());
}

/**
 * Writes the build's file list into src/sw.js, which Rollup has just built as its own entry. The
 * worker precaches exactly what this build emitted, and its cache name changes with them, so a
 * release never serves half of the old app and half of the new one.
 */
function precacheServiceWorker(): Plugin {
  let base = '/';
  let copied: readonly string[] = [];
  return {
    name: 'pos-precache-service-worker',
    apply: 'build',
    // After Vite's own build plugins, so index.html is in the bundle when the list is written.
    enforce: 'post',
    configResolved(config) {
      base = config.base;
      copied = config.build.copyPublicDir ? copiedPublicFiles(config.publicDir) : [];
    },
    generateBundle(_options, bundle) {
      const worker = bundle['sw.js'];
      if (!worker || worker.type !== 'chunk') {
        throw new Error('The build did not emit sw.js.');
      }
      const files = [...Object.keys(bundle).filter((name) => name !== 'sw.js'), ...copied]
        .map((name) => `${base}${name}`)
        .sort();
      worker.code = replaceOnce(
        replaceOnce(worker.code, /\[\s*(['"])__PRECACHE_MANIFEST__\1\s*\]/, JSON.stringify(files)),
        /__BUILD_ID__/g,
        buildId(files),
      );
    },
  };
}

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
  plugins: [react(), tailwindcss(), precacheServiceWorker()],
  resolve: {
    // Root-relative, so the alias resolves nothing itself; tsconfig.json mirrors it in "paths".
    alias: { '@': '/src' },
  },
  build: {
    rollupOptions: {
      // The worker is a second entry so Rollup builds it like any other script; it has to land at
      // the root of the site to control every page under it.
      input: { main: 'index.html', sw: 'src/sw.js' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        // Only modules from node_modules are moved; the app's own code, and the worker, which
        // imports nothing, stay where Rollup put them.
        manualChunks: (id) => vendorChunk(id),
      },
    },
  },
});
