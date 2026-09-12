import type { AuthUser, Backend, DiningTable } from '@/ports';

/**
 * What the port contract suites run against: one shop, seen through one backend per role, because
 * what a role may do is part of the contract. Each adapter builds it in its own contract.test.ts.
 *
 * Each backend holds exactly the role it is named after, so a refusal is unambiguous; a person who
 * holds several (the owner is admin and cashier) is the app's business, not the suite's.
 */
export interface ContractFixture {
  /** Signed in as an admin of the shop. */
  readonly admin: Backend;
  /** Signed in as a cashier of the same shop. */
  readonly cashier: Backend;
  /** Signed in as a waiter of the same shop: tables, never the ledger. */
  readonly waiter: Backend;
  /** Signed in as the kitchen of the same shop: prepares what it was sent, nothing else. */
  readonly kitchen: Backend;
  readonly adminUser: AuthUser;
  readonly cashierUser: AuthUser;
  readonly waiterUser: AuthUser;
  readonly kitchenUser: AuthUser;
  /**
   * A terminal code no test has used before, so tests never share receipt numbering, even on a
   * database that keeps its rows between runs. Every call returns another one.
   */
  readonly newTerminalCode: () => string;
  /**
   * An active table no test has used before, for the same reason: a test must find it free and may
   * leave an order open on it. Every call returns another one.
   */
  readonly newTable: () => Promise<DiningTable>;
  /** A table the admin has retired, which takes no order any more. */
  readonly retiredTable: () => Promise<DiningTable>;
}

/** Called before every test, so each test gets a fixture of its own. */
export type MakeFixture = () => Promise<ContractFixture>;

const CODE_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A random terminal code: "C" and seven letters or digits, one of 36^7. */
export function freshTerminalCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  const rest = Array.from(bytes, (byte) => CODE_CHARACTERS[byte % CODE_CHARACTERS.length]);
  return `C${rest.join('')}`;
}
