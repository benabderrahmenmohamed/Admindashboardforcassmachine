import { shopSettingsSchema, type SettingsPort } from '@/ports';
import type { MemoryStore } from './store';
import { authorize, parseInput, perform, type MemoryContext } from './support';

/** Anyone may read the settings; only an admin may change them, as on the legacy settings routes. */
export function createMemorySettings(context: MemoryContext, store: MemoryStore): SettingsPort {
  return {
    getSettings: () =>
      perform(context, 'settings.getSettings', () => structuredClone(store.settings)),

    updateSettings: (settings) =>
      perform(context, 'settings.updateSettings', () => {
        authorize(store, ['admin']);
        store.settings = parseInput(shopSettingsSchema, settings);
        return structuredClone(store.settings);
      }),
  };
}
