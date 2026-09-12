import type { AuthUser, Backend } from '@/ports';

/**
 * What the port contract suites run against: one shop, seen through a backend signed in as its admin
 * and a backend signed in as its cashier. Each adapter builds it in its own contract.test.ts.
 */
export interface ContractFixture {
  /** Signed in as an admin of the shop. */
  readonly admin: Backend;
  /** Signed in as a cashier of the same shop. */
  readonly cashier: Backend;
  readonly adminUser: AuthUser;
  readonly cashierUser: AuthUser;
  /**
   * A terminal code no test has used before, so tests never share receipt numbering, even on a
   * database that keeps its rows between runs. Every call returns another one.
   */
  readonly newTerminalCode: () => string;
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
