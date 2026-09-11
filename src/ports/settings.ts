import { z } from 'zod';

export const shopSettingsSchema = z.object({
  receiptFooter: z.string().max(500, 'Keep the footer under 500 characters'),
});
export type ShopSettings = z.infer<typeof shopSettingsSchema>;

/**
 * Settings as a backend returns them. Earlier versions saved footers of any length: those still
 * load, and the limit applies when they are next saved.
 */
export const storedShopSettingsSchema = z.object({
  receiptFooter: z.string(),
});

export interface SettingsPort {
  getSettings(): Promise<ShopSettings>;
  updateSettings(settings: ShopSettings): Promise<ShopSettings>;
}
