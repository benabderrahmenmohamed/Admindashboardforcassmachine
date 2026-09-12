import { terminalCodeSchema, terminalRegistrationSchema, type TerminalsPort } from '@/ports';
import type { SupabaseDatabaseClient } from './client';
import { unwrap } from './errors';
import { parseInput } from './validate';
import { fromWire } from './wire';

/** TerminalsPort over register_terminal, which creates the terminal or bumps its epoch. */
export function createSupabaseTerminals(client: SupabaseDatabaseClient): TerminalsPort {
  return {
    async register(code) {
      const terminalCode = parseInput(terminalCodeSchema, code);
      const data = await unwrap(client.rpc('register_terminal', { p_code: terminalCode }));
      return fromWire(terminalRegistrationSchema, data, 'the terminal registration');
    },
  };
}
