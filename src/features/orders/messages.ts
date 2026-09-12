/**
 * What a waiter, a cook or a cashier is told when an order event does not land.
 *
 * Decided from the error's code and nothing else — never from the message text — so the same answer
 * reads the same whichever backend gave it. The wording says what happened to the table rather than
 * what happened to the request, because that is what the person in front of the guest needs.
 */
import { toAppError } from '@/lib/errors';

export type OrderAction = 'add' | 'remove' | 'send' | 'prepare' | 'cancel';

const WHAT: Record<OrderAction, string> = {
  add: 'add that to the table',
  remove: 'take that off the table',
  send: 'tell the kitchen',
  prepare: 'mark that prepared',
  cancel: 'cancel the order',
};

export function orderErrorMessage(error: unknown, action: OrderAction): string {
  const { code, message } = toAppError(error);
  switch (code) {
    case 'NETWORK_ERROR':
      return `The server could not be reached, so nothing was changed. Try again once you have a connection.`;
    case 'SERVER_ERROR':
    case 'RATE_LIMITED':
      return 'The server could not take that just now. Try again in a moment.';
    case 'UNAUTHENTICATED':
      return 'Your sign-in has expired. Sign in again to carry on.';
    case 'FORBIDDEN':
      return `Your account is not allowed to ${WHAT[action]}.`;
    case 'TABLE_INACTIVE':
      return 'That table is out of service, so nothing can be put on it.';
    case 'ORDER_CLOSED':
      return 'That table was paid or cancelled, so it is free again. Open it afresh and order there.';
    case 'ORDER_CHANGED':
      return 'Somebody changed this table while you were looking at it. Check it and try again.';
    case 'ITEM_NOT_FOUND':
      return 'That item is no longer on the table: somebody else has already taken it off.';
    case 'NOT_FOUND':
      return 'Something this names does not exist in your shop any more.';
    case 'VALIDATION_ERROR':
      return message;
    case 'IDEMPOTENCY_CONFLICT':
    case 'SEQUENCE_GAP':
    case 'SESSION_CLOSED':
    case 'SESSION_ALREADY_OPEN':
    case 'TERMINAL_SUPERSEDED':
      return `This device could not ${WHAT[action]}: ${message}`;
    case 'CONFIG_ERROR':
      return `This device is not set up correctly: ${message}`;
    case 'UNKNOWN':
      return `Could not ${WHAT[action]}: ${message}`;
  }
}

/** Whether the screen should re-read the table before the person tries again. */
export function shouldRefreshTable(error: unknown): boolean {
  const { code } = toAppError(error);
  return code === 'ORDER_CHANGED' || code === 'ORDER_CLOSED' || code === 'ITEM_NOT_FOUND';
}
