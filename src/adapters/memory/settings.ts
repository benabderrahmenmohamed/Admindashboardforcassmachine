import { AppError } from '@/lib/errors';
import { shopSettingsSchema, type SettingsPort, type ShopSettings } from '@/ports';
import type { MemoryStore } from './store';
import { parseInput, perform, requireProfile, type MemoryContext } from './support';

function settingsOf(store: MemoryStore, shopId: string): ShopSettings {
  const settings = store.settings.get(shopId);
  if (!settings) {
    throw new AppError('UNKNOWN', `The shop ${shopId} has no settings`);
  }
  return settings;
}

/** The caller's shop settings: members read them, only an admin changes them (shop_settings). */
export function createMemorySettings(context: MemoryContext): SettingsPort {
  const { store } = context;
  return {
    getSettings: () =>
      perform(context, 'settings.getSettings', () => {
        const profile = requireProfile(context);
        return structuredClone(settingsOf(store, profile.shopId));
      }),

    updateSettings: (settings) =>
      perform(context, 'settings.updateSettings', () => {
        const profile = requireProfile(context, ['admin']);
        const next = parseInput(shopSettingsSchema, settings);
        settingsOf(store, profile.shopId);
        store.settings.set(profile.shopId, next);
        return structuredClone(next);
      }),
  };
}
