import { z } from 'zod';
import { millimesSchema, payloadHashSchema, recordIdSchema, timestampSchema } from './common';

const methodTotalsSchema = z.object({
  salesMillimes: millimesSchema,
  refundsMillimes: millimesSchema,
  netMillimes: millimesSchema,
});

/**
 * Totals of one cash session. Documents count in the session named on them.
 * gross = sum of sale totals; refunds = sum of refund totals as a positive amount; net = gross − refunds;
 * expectedCash = openingFloat + cash sales − cash refunds; variance = counted − expected.
 */
export const zReportSchema = z.object({
  sessionId: z.string().min(1),
  openingFloatMillimes: millimesSchema,
  salesCount: z.number().int().min(0),
  refundsCount: z.number().int().min(0),
  grossMillimes: millimesSchema,
  refundsMillimes: millimesSchema,
  netMillimes: millimesSchema,
  byMethod: z.object({ cash: methodTotalsSchema, card: methodTotalsSchema }),
  expectedCashMillimes: millimesSchema,
  countedCashMillimes: millimesSchema.nullable(),
  varianceMillimes: millimesSchema.nullable(),
  voidsCount: z.number().int().min(0),
});
export type ZReport = z.infer<typeof zReportSchema>;

export const cashSessionSchema = z.object({
  id: z.string().min(1),
  terminalId: z.string().min(1),
  terminalCode: z.string().min(1),
  openedBy: z.string().min(1),
  openedAt: timestampSchema,
  openingFloatMillimes: millimesSchema,
  closedAt: timestampSchema.nullable(),
  closedBy: z.string().nullable(),
  closingCountedMillimes: millimesSchema.nullable(),
  forceCloseReason: z.string().nullable(),
  /** The report stored when the session closed; null while it is open. */
  zReport: zReportSchema.nullable(),
});
export type CashSession = z.infer<typeof cashSessionSchema>;

export const writeStatusSchema = z.enum(['created', 'replayed']);
export type WriteStatus = z.infer<typeof writeStatusSchema>;

/** Written by the terminal, possibly offline. `actorUserId` is who opened it, not who synced it. */
export const openSessionRecordSchema = z.object({
  id: recordIdSchema,
  terminalCode: z.string().min(1),
  epoch: z.number().int().min(0),
  actorUserId: z.string().min(1),
  openedAt: timestampSchema,
  openingFloatMillimes: millimesSchema.refine(
    (value) => value >= 0,
    'The float cannot be negative',
  ),
  payloadHash: payloadHashSchema,
});
export type OpenSessionRecord = z.infer<typeof openSessionRecordSchema>;

/** `id` identifies this close request; `sessionId` the session it closes. */
export const closeSessionRecordSchema = z.object({
  id: recordIdSchema,
  sessionId: z.string().min(1),
  terminalCode: z.string().min(1),
  epoch: z.number().int().min(0),
  actorUserId: z.string().min(1),
  closedAt: timestampSchema,
  closingCountedMillimes: millimesSchema.refine(
    (value) => value >= 0,
    'Counted cash cannot be negative',
  ),
  /** What the terminal computed locally, kept next to the server's report. */
  clientZReport: zReportSchema.nullable(),
  payloadHash: payloadHashSchema,
});
export type CloseSessionRecord = z.infer<typeof closeSessionRecordSchema>;

export const openSessionResultSchema = z.object({
  sessionId: z.string().min(1),
  status: writeStatusSchema,
  session: cashSessionSchema,
});
export type OpenSessionResult = z.infer<typeof openSessionResultSchema>;

export const closeSessionResultSchema = z.object({
  sessionId: z.string().min(1),
  status: writeStatusSchema,
  zReport: zReportSchema,
});
export type CloseSessionResult = z.infer<typeof closeSessionResultSchema>;

export interface SessionsPort {
  open(record: OpenSessionRecord): Promise<OpenSessionResult>;
  close(record: CloseSessionRecord): Promise<CloseSessionResult>;
  /** The open session of a terminal, or null. */
  current(terminalId: string): Promise<CashSession | null>;
  /** The stored report of a closed session, or the running report of an open one. */
  zReport(sessionId: string): Promise<ZReport>;
}
