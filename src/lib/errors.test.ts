import { describe, expect, it } from 'vitest';
import errorsContract from '../../contracts/errors.md?raw';
import {
  AppError,
  ERROR_CODES,
  errorClass,
  errorMessage,
  isAppError,
  isErrorCode,
  toAppError,
  type ErrorClass,
  type ErrorCode,
} from './errors';

// Black-box tests of the error contract (contracts/errors.md): the codes, the class each one
// belongs to, and the helpers that turn anything thrown into an AppError.

const CLASSES: [ErrorCode, ErrorClass][] = [
  ['NETWORK_ERROR', 'retriable'],
  ['SERVER_ERROR', 'retriable'],
  ['RATE_LIMITED', 'retriable'],
  ['UNAUTHENTICATED', 'auth'],
  ['FORBIDDEN', 'conflict'],
  ['NOT_FOUND', 'conflict'],
  ['VALIDATION_ERROR', 'conflict'],
  ['IDEMPOTENCY_CONFLICT', 'conflict'],
  ['SEQUENCE_GAP', 'conflict'],
  ['SESSION_CLOSED', 'conflict'],
  ['SESSION_ALREADY_OPEN', 'conflict'],
  ['TERMINAL_SUPERSEDED', 'conflict'],
  ['CONFIG_ERROR', 'conflict'],
  ['UNKNOWN', 'conflict'],
];

/** The rows of the Codes table in contracts/errors.md, as [code, class]. */
function contractRows(markdown: string): [string, string][] {
  return markdown
    .split(/\r?\n/)
    .map((line) => /^\|\s*`([A-Z_]+)`\s*\|[^|]*\|\s*([a-z]+)\s*\|/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [match[1], match[2]]);
}

describe('ERROR_CODES', () => {
  it('lists exactly the codes of the contract, in its order', () => {
    expect(ERROR_CODES).toEqual(CLASSES.map(([code]) => code));
  });

  it('matches the Codes table in contracts/errors.md, code by code and class by class', () => {
    const rows = contractRows(errorsContract);

    expect(rows).toHaveLength(14);
    expect(rows).toEqual(ERROR_CODES.map((code) => [code, errorClass(code)]));
  });
});

describe('errorClass', () => {
  it.each(CLASSES)('puts %s in the %s class', (code, expected) => {
    expect(errorClass(code)).toBe(expected);
  });
});

describe('isErrorCode', () => {
  it.each(ERROR_CODES)('accepts %s', (code) => {
    expect(isErrorCode(code)).toBe(true);
  });

  it.each([
    'sequence_gap',
    'Sequence_Gap',
    ' SEQUENCE_GAP',
    'SEQUENCE_GAP ',
    'PT409',
    '409',
    '',
    'toString',
    'constructor',
    undefined,
    null,
    409,
    true,
    {},
    ['SEQUENCE_GAP'],
  ])('rejects %j', (value) => {
    expect(isErrorCode(value)).toBe(false);
  });
});

describe('AppError', () => {
  it('is an Error carrying its code, message and details', () => {
    const details = { expectedSeq: 42, receivedSeq: 43 };
    const error = new AppError('SEQUENCE_GAP', 'Expected receipt T1-42.', { details });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('SEQUENCE_GAP');
    expect(error.message).toBe('Expected receipt T1-42.');
    expect(error.details).toEqual({ expectedSeq: 42, receivedSeq: 43 });
    expect(typeof error.stack).toBe('string');
  });

  it('has no details and no cause unless given', () => {
    const error = new AppError('NETWORK_ERROR', 'Offline');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it('keeps the cause it wraps', () => {
    const cause = new TypeError('Failed to fetch');
    const error = new AppError('NETWORK_ERROR', 'Offline', { cause });

    expect(error.cause).toBe(cause);
  });
});

describe('isAppError', () => {
  it('recognises AppError instances only, never look-alikes', () => {
    expect(isAppError(new AppError('FORBIDDEN', 'No'))).toBe(true);

    const lookAlike = Object.assign(new Error('No'), { code: 'FORBIDDEN' });
    expect(isAppError(lookAlike)).toBe(false);
    expect(isAppError({ code: 'FORBIDDEN', message: 'No', name: 'AppError' })).toBe(false);
    expect(isAppError(new Error('No'))).toBe(false);
    expect(isAppError('FORBIDDEN')).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });
});

describe('toAppError', () => {
  it('returns an AppError as the same instance', () => {
    const error = new AppError('SESSION_CLOSED', 'Closed', { details: { sessionId: 's1' } });

    expect(toAppError(error)).toBe(error);
  });

  it('wraps any other Error as UNKNOWN with its message, keeping it as the cause', () => {
    const cause = new RangeError('Out of range');
    const error = toAppError(cause);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('UNKNOWN');
    expect(error.message).toBe('Out of range');
    expect(error.cause).toBe(cause);
    expect(error.details).toBeUndefined();
  });

  it('never trusts a code property on something that is not an AppError', () => {
    const lookAlike = Object.assign(new Error('Retry later'), { code: 'NETWORK_ERROR' });

    expect(toAppError(lookAlike).code).toBe('UNKNOWN');
    expect(toAppError({ code: 'NETWORK_ERROR' }).code).toBe('UNKNOWN');
  });

  it.each([
    ['a string'],
    [42],
    [null],
    [undefined],
    [{ message: 'not an Error' }],
    [new Error('')],
  ])('wraps %j as UNKNOWN with a generic message', (value) => {
    const error = toAppError(value);

    expect(error.code).toBe('UNKNOWN');
    expect(error.message).toBe('Unexpected error');
    expect(error.cause).toBe(value);
  });
});

describe('errorMessage', () => {
  it("uses the error's own message when there is one", () => {
    expect(errorMessage(new AppError('FORBIDDEN', 'Your role cannot do this.'), 'Failed')).toBe(
      'Your role cannot do this.',
    );
    expect(errorMessage(new Error('Boom'), 'Failed')).toBe('Boom');
  });

  it.each([[new Error('')], ['Boom'], [{ message: 'Boom' }], [null], [undefined]])(
    'falls back for %j',
    (value) => {
      expect(errorMessage(value, 'Failed')).toBe('Failed');
    },
  );
});
