/// <reference types="vite-plugin-pwa/vanillajs" />
/**
 * Registers the offline app shell that vite-plugin-pwa builds (see vite.config.ts).
 *
 * index.html loads this file on its own and no module of the app imports it: `virtual:pwa-register`
 * exists only where the plugin runs, so a test that imported it would fail before it started.
 */
import { toast } from 'sonner';
import { registerSW } from 'virtual:pwa-register';
import { toAppError } from '@/lib/errors';

/**
 * The cache the hand-written worker before vite-plugin-pwa kept the shell in, one per build. Nothing
 * reads it any more, and the new worker only cleans up caches of its own making.
 */
const RETIRED_CACHE_PREFIX = 'pos-shell-';

async function dropRetiredCaches(): Promise<void> {
  if (!('caches' in globalThis)) {
    return;
  }
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(RETIRED_CACHE_PREFIX))
      .map((name) => caches.delete(name)),
  );
}

// Only a built app has a worker to register; the dev server serves source modules, not the shell.
if (import.meta.env.PROD) {
  const updateServiceWorker = registerSW({
    // A new release waits for a person to say when. Taking over on its own reloads the page, and a
    // till mid-payment would lose the table it had chosen and the amount it was handed — what was
    // tapped is safe in the outbox, but what was being typed is not.
    onNeedRefresh() {
      toast('A new version of the app is ready.', {
        description: 'Reload when nobody is in the middle of a sale or an order.',
        duration: Infinity,
        action: {
          label: 'Reload',
          onClick: () => {
            updateServiceWorker(true).catch((error: unknown) => {
              console.error('The new version could not be started', toAppError(error));
            });
          },
        },
      });
    },
    onRegisterError(error: unknown) {
      console.error('The offline app shell could not be registered', toAppError(error));
    },
  });
  dropRetiredCaches().catch((error: unknown) => {
    console.error('An old copy of the app shell could not be removed', toAppError(error));
  });
}
