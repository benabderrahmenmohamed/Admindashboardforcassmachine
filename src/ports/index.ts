import type { BackendKind } from '@/lib/env';
import type { AuthPort } from './auth';
import type { CatalogPort } from './catalog';
import type { SalesPort } from './sales';
import type { SettingsPort } from './settings';

export * from './auth';
export * from './catalog';
export * from './common';
export * from './sales';
export * from './settings';

/** Sign-in shortcut offered by the credential-free demo backend. */
export interface DemoAccount {
  readonly label: string;
  readonly email: string;
  readonly password: string;
}

/** Everything the UI may use to reach data. Built once by src/lib/backend.ts. */
export interface Backend {
  readonly kind: BackendKind;
  readonly auth: AuthPort;
  readonly catalog: CatalogPort;
  readonly sales: SalesPort;
  readonly settings: SettingsPort;
  /** Only the memory backend has these; there is nothing real behind them. */
  readonly demoAccounts?: readonly DemoAccount[];
}
