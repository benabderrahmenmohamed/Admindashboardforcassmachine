import { z } from 'zod';
import {
  shopSettingsSchema,
  storedShopSettingsSchema,
  type SettingsPort,
  type ShopSettings,
} from '@/ports';
import type { EdgeRequest } from './http';
import { parseInput, parseOutput } from './validate';

/** The footer the old Settings page showed as its placeholder. */
const DEFAULT_RECEIPT_FOOTER = 'Thank you for your purchase!';

const settingsBodySchema = z.object({ settings: z.record(z.string(), z.unknown()) });

function toShopSettings(stored: Record<string, unknown>): ShopSettings {
  return parseOutput(
    storedShopSettingsSchema,
    { receiptFooter: stored.receiptFooter ?? DEFAULT_RECEIPT_FOOTER },
    'the settings',
  );
}

/**
 * SettingsPort over the legacy `pos:settings` value. Writes keep the keys this app no longer uses
 * (mode, currency, taxRate), so older clients still find them.
 */
export function createSupabaseSettings(request: EdgeRequest): SettingsPort {
  async function readStored(): Promise<Record<string, unknown>> {
    const body = await request('/settings', { method: 'GET', auth: 'anon' });
    return parseOutput(settingsBodySchema, body, 'the settings').settings;
  }

  return {
    async getSettings() {
      return toShopSettings(await readStored());
    },

    async updateSettings(settings) {
      const { receiptFooter } = parseInput(shopSettingsSchema, settings);
      const stored = await readStored();
      const body = await request('/settings', {
        method: 'PUT',
        auth: 'user',
        body: { ...stored, receiptFooter },
      });
      return toShopSettings(parseOutput(settingsBodySchema, body, 'the saved settings').settings);
    },
  };
}
