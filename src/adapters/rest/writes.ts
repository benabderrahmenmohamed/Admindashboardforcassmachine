import { AppError } from '@/lib/errors';

/** The status a first write answers with (contracts/openapi.yaml). */
export const HTTP_CREATED = 201;

/**
 * Checks a record write's outcome against its status line. contracts/errors.md gives every write
 * two answers: 201 for the record the server stored now, 200 for one it had already (`replayed`,
 * `voided`, `recorded`). The body names the outcome, and the two must agree; a response where they
 * do not cannot be read with confidence, and no retry makes it readable, so it is VALIDATION_ERROR
 * like any other unreadable answer (src/lib/validation.ts).
 *
 * `createdStatus` is the outcome that belongs to 201: `created` for a sale or a session,
 * `voided` for a receipt void.
 */
export function checkWriteOutcome(
  httpStatus: number,
  outcome: string,
  createdStatus: string,
  what: string,
): void {
  if ((httpStatus === HTTP_CREATED) !== (outcome === createdStatus)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `The server answered ${what} with HTTP ${httpStatus} and "${outcome}", which the contract does not allow.`,
      { details: { status: httpStatus, outcome, createdStatus } },
    );
  }
}
