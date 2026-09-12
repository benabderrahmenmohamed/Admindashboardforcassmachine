import { parseOrInvalid } from '@/lib/validation';
import { shopSettingsSchema, storedShopSettingsSchema, type SettingsPort } from '@/ports';
import type { RestClient } from './http';
import { fromWire, toWire, type WireShopSettings } from './wire';

/**
 * SettingsPort over /shop-settings. What is read is checked with the lenient stored schema, since a
 * footer saved before the length limit still has to load; what is saved is checked with the strict
 * one (src/ports/settings.ts).
 */
export function createRestSettings(client: RestClient): SettingsPort {
  return {
    async getSettings() {
      const response = await client.request('GET', '/shop-settings');
      return fromWire(storedShopSettingsSchema, response.body, 'the settings');
    },

    async updateSettings(settings) {
      const input = parseOrInvalid(shopSettingsSchema, settings, 'the settings');
      const response = await client.request('PUT', '/shop-settings', {
        body: toWire<WireShopSettings>(input),
      });
      return fromWire(storedShopSettingsSchema, response.body, 'the saved settings');
    },
  };
}
