import type { BackendKind } from '@/lib/env';
import type { AuthPort } from './auth';
import type { CatalogPort } from './catalog';
import type { OrdersPort } from './orders';
import type { RealtimePort } from './realtime';
import type { SalesPort } from './sales';
import type { SessionsPort } from './sessions';
import type { SettingsPort } from './settings';
import type { TerminalsPort } from './terminals';

export * from './auth';
export * from './catalog';
export * from './common';
export * from './orders';
export * from './realtime';
export * from './sales';
export * from './sessions';
export * from './settings';
export * from './terminals';

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
  readonly orders: OrdersPort;
  readonly realtime: RealtimePort;
  readonly sales: SalesPort;
  readonly sessions: SessionsPort;
  readonly settings: SettingsPort;
  readonly terminals: TerminalsPort;
  /** Only the memory backend has these; there is nothing real behind them. */
  readonly demoAccounts?: readonly DemoAccount[];
}
