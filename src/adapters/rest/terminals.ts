import { parseOrInvalid } from '@/lib/validation';
import { terminalCodeSchema, terminalRegistrationSchema, type TerminalsPort } from '@/ports';
import type { RestClient } from './http';
import { pathSegment } from './paths';
import { fromWire } from './wire';

/**
 * TerminalsPort over `POST /terminals/{code}/registrations`. The code is trimmed and upper-cased
 * here, as the port schema defines it, so ` t1 ` registers T1; a code that is not 1 to 8 letters or
 * digits is VALIDATION_ERROR and no request is made. Whether the caller may register — admin only —
 * is the server's decision.
 */
export function createRestTerminals(client: RestClient): TerminalsPort {
  return {
    async register(code) {
      const terminalCode = parseOrInvalid(terminalCodeSchema, code, 'the terminal code');
      const response = await client.request(
        'POST',
        `/terminals/${pathSegment(terminalCode, 'the terminal code')}/registrations`,
      );
      return fromWire(terminalRegistrationSchema, response.body, 'the terminal registration');
    },
  };
}
