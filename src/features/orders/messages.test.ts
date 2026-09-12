import { describe, expect, it } from 'vitest';
import { AppError, ERROR_CODES } from '@/lib/errors';
import { orderErrorMessage, type OrderAction } from './messages';

const ACTIONS: readonly OrderAction[] = ['add', 'remove', 'send', 'prepare', 'cancel'];

describe('orderErrorMessage', () => {
  it('has an answer for every code, for every action', () => {
    for (const code of ERROR_CODES) {
      for (const action of ACTIONS) {
        const message = orderErrorMessage(new AppError(code, 'raw text'), action);
        expect(message.length, `${code} / ${action}`).toBeGreaterThan(0);
      }
    }
  });

  it('tells a waiter a paid table is free again rather than showing a code', () => {
    expect(orderErrorMessage(new AppError('ORDER_CLOSED', 'ORDER_CLOSED'), 'add')).toBe(
      'That table was paid or cancelled, so it is free again. Open it afresh and order there.',
    );
  });

  it('names what was being done when the account is not allowed to do it', () => {
    expect(orderErrorMessage(new AppError('FORBIDDEN', 'no'), 'send')).toBe(
      'Your account is not allowed to tell the kitchen.',
    );
    expect(orderErrorMessage(new AppError('FORBIDDEN', 'no'), 'remove')).toBe(
      'Your account is not allowed to take that off the table.',
    );
  });

  it('reads the code, not the message text', () => {
    const misleading = new AppError('ORDER_CHANGED', 'the table is out of service');

    expect(orderErrorMessage(misleading, 'add')).toContain('Somebody changed this table');
  });

  it('passes a validation message through, because it says which field is wrong', () => {
    expect(
      orderErrorMessage(
        new AppError('VALIDATION_ERROR', 'Say why the item is being removed'),
        'remove',
      ),
    ).toBe('Say why the item is being removed');
  });

  it('turns something that is not an AppError into an answer rather than throwing', () => {
    expect(orderErrorMessage(new TypeError('boom'), 'add')).toContain('boom');
  });
});
