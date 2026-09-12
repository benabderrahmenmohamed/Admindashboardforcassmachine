/**
 * What the Settings terminal card shows and when it refuses to register, kept out of the component
 * so it runs without a DOM. Messages returned here are the text the admin sees.
 */
import { z } from 'zod';
import { receiptNumber } from '@/features/sales/records';
import { terminalCodeSchema } from '@/ports';
import type { PendingRecord, StoredTerminal } from '../terminalStore';

/** The code typed to register this device; the port's rule trims and upper-cases it. */
export const registerTerminalFormSchema = z.object({ code: terminalCodeSchema });
export type RegisterTerminalFormValues = z.infer<typeof registerTerminalFormSchema>;

/** This device's registration as the card lists it. */
export interface RegistrationSummary {
  readonly code: string;
  readonly epoch: number;
  /** The last receipt number this device used or adopted, or null before the first one. */
  readonly lastReceipt: string | null;
}

export function registrationSummary(terminal: StoredTerminal | null): RegistrationSummary | null {
  if (!terminal) {
    return null;
  }
  return {
    code: terminal.code,
    epoch: terminal.epoch,
    lastReceipt: terminal.lastSeq > 0 ? receiptNumber(terminal.code, terminal.lastSeq) : null,
  };
}

/** The unsent record in words, e.g. "sale T1-43" or "session close". */
export function describePendingRecord(pending: PendingRecord): string {
  switch (pending.type) {
    case 'sale':
      return `${pending.record.kind} ${receiptNumber(pending.record.terminalCode, pending.record.seq)}`;
    case 'session_open':
      return 'session opening';
    case 'session_close':
      return 'session close';
  }
}

/**
 * Why this device cannot be registered now, or null when it can. Registering bumps the terminal's
 * epoch, so a record still waiting to be sent would be refused under the new registration.
 */
export function registerBlockedReason(pending: PendingRecord | null): string | null {
  if (!pending) {
    return null;
  }
  return (
    `This device has an unsent ${describePendingRecord(pending)}. Registering now would strand it ` +
    'under the old registration: a cashier has to send it from the POS on this device first.'
  );
}

/**
 * The question asked before registering `code`. A registration replaces every earlier one of the
 * same code, on this device or any other.
 */
export function registerConfirmMessage(code: string, current: StoredTerminal | null): string {
  const replaced = `Any other device registered as ${code} will have to be registered again before it can record sales.`;
  if (current && current.code !== code) {
    return `This device is terminal ${current.code}. Register it as ${code} instead? ${replaced}`;
  }
  return `Register this device as terminal ${code}? ${replaced}`;
}
