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
 * Writes the build's file list into src/sw.js, which Rollup has just built as its own entry. The
 * worker precaches exactly what this build emitted, and its cache name changes with them, so a
 * release never serves half of the old app and half of the new one.
 */
function precacheServiceWorker(): Plugin {
  let base = '/';
  return {
    name: 'pos-precache-service-worker',
    apply: 'build',
    // After Vite's own build plugins, so index.html is in the bundle when the list is written.
    enforce: 'post',
    configResolved(config) {
      base = config.base;
    },
    generateBundle(_options, bundle) {
      const worker = bundle['sw.js'];
      if (!worker || worker.type !== 'chunk') {
        throw new Error('The build did not emit sw.js.');
      }
      const files = Object.keys(bundle)
        .filter((name) => name !== 'sw.js')
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

export default defineConfig({
  plugins: [react(), tailwindcss(), precacheServiceWorker()],
  resolve: {
    // Root-relative, so the config needs no Node path APIs; tsconfig.json mirrors it in "paths".
    alias: { '@': '/src' },
  },
  build: {
    rollupOptions: {
      // The worker is a second entry so Rollup builds it like any other script; it has to land at
      // the root of the site to control every page under it.
      input: { main: 'index.html', sw: 'src/sw.js' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
