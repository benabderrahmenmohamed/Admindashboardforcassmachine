/**
 * What the Settings terminal card shows and when it refuses to register, kept out of the component
 * so it runs without a DOM. Messages returned here are the text the admin sees.
 */
import { z } from 'zod';
import { isUnfinished } from '@/features/pos/queue';
import { receiptNumber } from '@/features/sales/records';
import type { OutboxMeta, OutboxRecord } from '@/features/sync/types';
import { terminalCodeSchema } from '@/ports';

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

export function registrationSummary(terminal: OutboxMeta | null): RegistrationSummary | null {
  if (!terminal) {
    return null;
  }
  return {
    code: terminal.code,
    epoch: terminal.epoch,
    lastReceipt: terminal.lastSeq > 0 ? receiptNumber(terminal.code, terminal.lastSeq) : null,
  };
}

/** A record in the queue in a few words, e.g. "sale T1-43" or "session close". */
export function describeQueued(record: OutboxRecord): string {
  switch (record.kind) {
    case 'sale':
    case 'refund':
      return `${record.kind} ${receiptNumber(record.terminalCode, record.seq)}`;
    case 'session_open':
      return 'session opening';
    case 'session_close':
      return 'session close';
  }
}

/**
 * Why this device cannot be registered now, or null when it can. Registering bumps the terminal's
 * epoch, so every record still in the queue would be refused under the new registration, and the
 * receipt numbers they hold would be lost with them.
 */
export function registerBlockedReason(records: readonly OutboxRecord[]): string | null {
  const waiting = records.filter(isUnfinished);
  const first = waiting[0];
  if (!first) {
    return null;
  }
  const count =
    waiting.length === 1 ? 'an unsent record' : `${waiting.length} records waiting to be sent`;
  const stopped = waiting.some((record) => record.status === 'conflict');
  return (
    `This device has ${count}, starting with ${describeQueued(first)}. Registering now would ` +
    `strand ${waiting.length === 1 ? 'it' : 'them'} under the old registration: ` +
    (stopped
      ? 'the queue is stopped, so sort it out on the POS on this device first.'
      : 'let the queue empty on the POS on this device first.')
  );
}

/**
 * The question asked before registering `code`. A registration replaces every earlier one of the
 * same code, on this device or any other.
 */
export function registerConfirmMessage(code: string, current: OutboxMeta | null): string {
  const replaced = `Any other device registered as ${code} will have to be registered again before it can record sales.`;
  if (current && current.code !== code) {
    return `This device is terminal ${current.code}. Register it as ${code} instead? ${replaced}`;
  }
  return `Register this device as terminal ${code}? ${replaced}`;
}
