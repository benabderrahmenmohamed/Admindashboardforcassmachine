import type { TerminalContext } from '@/features/terminal/types';
import type { Millimes } from '@/lib/money';
import { withPayloadHash } from '@/lib/payloadHash';
import { parseOrInvalid } from '@/lib/validation';
import {
  closeSessionRecordSchema,
  openSessionRecordSchema,
  type CloseSessionRecord,
  type OpenSessionRecord,
  type ZReport,
} from '@/ports';

/** A session-open record. `actorUserId` is the cashier opening it, which may differ from who syncs it. */
export async function buildOpenSessionRecord(input: {
  readonly id: string;
  readonly terminal: TerminalContext;
  readonly actorUserId: string;
  readonly openedAt: string;
  readonly openingFloatMillimes: Millimes;
}): Promise<OpenSessionRecord> {
  const record = await withPayloadHash({
    id: input.id,
    terminalCode: input.terminal.terminalCode,
    epoch: input.terminal.epoch,
    actorUserId: input.actorUserId,
    openedAt: input.openedAt,
    openingFloatMillimes: input.openingFloatMillimes,
  });
  return parseOrInvalid(openSessionRecordSchema, record, 'the session opening');
}

/** A session-close record, carrying the Z-report the terminal computed locally. */
export async function buildCloseSessionRecord(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly terminal: TerminalContext;
  readonly actorUserId: string;
  readonly closedAt: string;
  readonly closingCountedMillimes: Millimes;
  readonly clientZReport: ZReport | null;
}): Promise<CloseSessionRecord> {
  const record = await withPayloadHash({
    id: input.id,
    sessionId: input.sessionId,
    terminalCode: input.terminal.terminalCode,
    epoch: input.terminal.epoch,
    actorUserId: input.actorUserId,
    closedAt: input.closedAt,
    closingCountedMillimes: input.closingCountedMillimes,
    clientZReport: input.clientZReport,
  });
  return parseOrInvalid(closeSessionRecordSchema, record, 'the session closing');
}
