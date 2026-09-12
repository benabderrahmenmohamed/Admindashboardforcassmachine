import { describe, expect, it } from 'vitest';
import { closeRecord, meta, openRecord, saleRecord } from '@/features/pos/__fixtures__/records';
import { AppError } from '@/lib/errors';
import {
  describeQueued,
  registerBlockedReason,
  registerConfirmMessage,
  registerTerminalFormSchema,
  registrationSummary,
} from './registration';

const terminal = meta({ epoch: 3, lastSeq: 42 });

describe('registerTerminalFormSchema', () => {
  it.each([
    { typed: 'T1', code: 'T1' },
    { typed: ' t1 ', code: 'T1' },
    { typed: 'pos02', code: 'POS02' },
    { typed: '12345678', code: '12345678' },
  ])('reads $typed as $code', ({ typed, code }) => {
    expect(registerTerminalFormSchema.parse({ code: typed })).toEqual({ code });
  });

  it.each(['', '   ', 'T-1', 'T 1', 'ABCDEFGHI', 'TÉ'])('rejects %j', (typed) => {
    const result = registerTerminalFormSchema.safeParse({ code: typed });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Use 1 to 8 letters or digits',
    ]);
  });
});

describe('registrationSummary', () => {
  it('is null for a device that is not registered', () => {
    expect(registrationSummary(null)).toBeNull();
  });

  it('lists the code, the epoch and the last receipt number', () => {
    expect(registrationSummary(terminal)).toEqual({ code: 'T1', epoch: 3, lastReceipt: 'T1-42' });
  });

  it('has no last receipt before the terminal numbers its first one', () => {
    expect(registrationSummary(meta({ lastSeq: 0 }))?.lastReceipt).toBeNull();
  });
});

describe('describeQueued', () => {
  it.each([
    { name: 'a sale', record: saleRecord({ seq: 43 }), text: 'sale T1-43' },
    {
      name: 'a refund',
      record: saleRecord({ seq: 44, kind: 'refund', terminalCode: 'POS2' }),
      text: 'refund POS2-44',
    },
    { name: 'a session opening', record: openRecord(), text: 'session opening' },
    { name: 'a session close', record: closeRecord(), text: 'session close' },
  ])('names $name', ({ record, text }) => {
    expect(describeQueued(record)).toBe(text);
  });
});

describe('registerBlockedReason', () => {
  it('lets a device with an empty queue register', () => {
    expect(registerBlockedReason([])).toBeNull();
    expect(registerBlockedReason([saleRecord({ seq: 43, status: 'acked' })])).toBeNull();
    expect(registerBlockedReason([saleRecord({ seq: 43, status: 'voided' })])).toBeNull();
  });

  it('refuses while a record waits to be sent, and says which one and why', () => {
    const reason = registerBlockedReason([saleRecord({ seq: 43, ordinal: 1 })]);

    expect(reason).toBe(
      'This device has an unsent record, starting with sale T1-43. Registering now would strand ' +
        'it under the old registration: let the queue empty on the POS on this device first.',
    );
  });

  it('counts what is waiting and points at the queue when it is stopped', () => {
    const reason = registerBlockedReason([
      saleRecord({
        seq: 43,
        ordinal: 1,
        status: 'conflict',
        lastError: new AppError('SEQUENCE_GAP', 'gap'),
      }),
      closeRecord({ ordinal: 2 }),
    ]);

    expect(reason).toContain('2 records waiting to be sent, starting with sale T1-43');
    expect(reason).toContain('the queue is stopped');
  });
});

describe('registerConfirmMessage', () => {
  const replaced =
    'Any other device registered as T1 will have to be registered again before it can record sales.';

  it('asks before a first registration', () => {
    expect(registerConfirmMessage('T1', null)).toBe(
      `Register this device as terminal T1? ${replaced}`,
    );
  });

  it('asks the same before registering the same code again', () => {
    expect(registerConfirmMessage('T1', terminal)).toBe(
      `Register this device as terminal T1? ${replaced}`,
    );
  });

  it('names the current code when the device changes terminal', () => {
    expect(registerConfirmMessage('T2', terminal)).toBe(
      'This device is terminal T1. Register it as T2 instead? Any other device registered as T2 ' +
        'will have to be registered again before it can record sales.',
    );
  });
});
