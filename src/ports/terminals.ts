import { z } from 'zod';
import { cashSessionSchema } from './sessions';

export const terminalCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,8}$/, 'Use 1 to 8 letters or digits');

/**
 * The result of registering this device as a terminal. The device adopts `lastSeq` as its receipt
 * counter and `epoch` as its registration; a later registration elsewhere supersedes it.
 */
export const terminalRegistrationSchema = z.object({
  terminalId: z.string().min(1),
  code: z.string().min(1),
  lastSeq: z.number().int().min(0),
  epoch: z.number().int().min(0),
  /** The terminal's open session, which this device continues. */
  openSession: cashSessionSchema.nullable(),
});
export type TerminalRegistration = z.infer<typeof terminalRegistrationSchema>;

export interface TerminalsPort {
  /** Admin only. Creates the terminal on first use and bumps its epoch every time. */
  register(code: string): Promise<TerminalRegistration>;
}
