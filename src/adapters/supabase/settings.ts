import { AppError } from '@/lib/errors';
import {
  shopSettingsSchema,
  storedShopSettingsSchema,
  type SettingsPort,
  type ShopSettings,
} from '@/ports';
import type { SupabaseDatabaseClient } from './client';
import { unwrap } from './errors';
import { requireAdmin } from './profile';
import { parseInput, parseOutput } from './validate';

/** The default of shop_settings.receipt_footer, shown while a shop has no settings row. */
const DEFAULT_RECEIPT_FOOTER = 'Thank you for your purchase!';

function toShopSettings(receiptFooter: string): ShopSettings {
  return parseOutput(storedShopSettingsSchema, { receiptFooter }, 'the settings');
}

/** SettingsPort over shop_settings, whose row-level security shows only the caller's shop. */
export function createSupabaseSettings(client: SupabaseDatabaseClient): SettingsPort {
  return {
    async getSettings() {
      const row = await unwrap(client.from('shop_settings').select('receipt_footer').maybeSingle());
      return toShopSettings(row?.receipt_footer ?? DEFAULT_RECEIPT_FOOTER);
    },

    async updateSettings(settings) {
      const { receiptFooter } = parseInput(shopSettingsSchema, settings);
      const admin = await requireAdmin(client);
      const rows = await unwrap(
        client
          .from('shop_settings')
          .update({ receipt_footer: receiptFooter })
          .eq('shop_id', admin.shopId)
          .select('receipt_footer'),
      );
      if (rows.length === 0) {
        throw new AppError('NOT_FOUND', 'This shop has no settings to change yet.', {
          details: { shopId: admin.shopId },
        });
      }
      return toShopSettings(rows[0].receipt_footer);
    },
  };
}
