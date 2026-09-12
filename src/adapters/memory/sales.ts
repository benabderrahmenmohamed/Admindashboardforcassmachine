import { receiptNumber } from '@/features/sales/records';
import { AppError } from '@/lib/errors';
import {
  listSalesQuerySchema,
  MAX_PRICE_MILLIMES,
  type RecordSaleResult,
  type SaleLine,
  type SalesPort,
  type VoidReceiptResult,
} from '@/ports';
import { refundedOf, requireEpoch, requireNextSeq, saleView, terminalFor } from './ledger';
import type { MemoryProfile } from './seed';
import { saleRecordInput, voidReceiptInput } from './shapes';
import {
  moveStock,
  type MemoryReceiptVoid,
  type MemoryTerminal,
  type SaleRow,
  type SessionRow,
} from './store';
import {
  invalidField,
  parseInput,
  parseRef,
  parseTimestamp,
  parseUuid,
  perform,
  requireProfile,
  type MemoryContext,
} from './support';

/** A document's lines as stored, with the amounts recomputed from them. */
interface CheckedLines {
  readonly lines: SaleLine[];
  readonly subtotal: bigint;
  readonly discount: bigint;
  readonly total: bigint;
}

function lineError(lineNo: number, message: string): AppError {
  return new AppError('VALIDATION_ERROR', message, { details: { lineNo } });
}

/**
 * The sales ledger, as record_sale and void_receipt, in their order of checks (contracts/errors.md):
 * caller, terminal, replay, registration, session, numbering, then the document recomputed from its
 * lines. Any member records; only an admin voids. Amounts are checked in bigint, like the
 * database's bigint columns, so no sum ever leaves the safe integers unnoticed.
 */
export function createMemorySales(context: MemoryContext): SalesPort {
  const { store } = context;

  /** The session a record names: it exists, belongs to this terminal and is still open. */
  function sessionForRecord(
    profile: MemoryProfile,
    terminal: MemoryTerminal,
    sessionId: string,
  ): SessionRow {
    const id = parseUuid(sessionId, 'session_id');
    const session = store.sessions.get(id);
    if (!session) {
      throw new AppError('NOT_FOUND', 'The session does not exist.', {
        details: { sessionId: id },
      });
    }
    if (session.shopId !== profile.shopId || session.terminalId !== terminal.id) {
      throw new AppError('FORBIDDEN', 'The session does not belong to this terminal.', {
        details: { sessionId: session.id },
      });
    }
    if (session.closedAt !== null) {
      throw new AppError('SESSION_CLOSED', 'The session was closed before this record arrived.', {
        details: { sessionId: session.id },
      });
    }
    return session;
  }

  /**
   * Lines numbered 1, 2, 3, naming products of the shop (archived ones included) at a unit price
   * within the product bound: what record_sale checks for a line of either kind, in its order.
   */
  function lineProductId(profile: MemoryProfile, line: SaleLine, index: number): string {
    if (line.lineNo !== index + 1) {
      throw invalidField('lines', 'Lines must be numbered 1, 2, 3 in order.');
    }
    const productId = parseUuid(line.productId, 'product_id');
    if (store.products.get(productId)?.shopId !== profile.shopId) {
      throw new AppError('NOT_FOUND', 'A line names a product that does not exist.', {
        details: { productId },
      });
    }
    // A unit price is a product price: at most one billion dinars, the bound the ports read rows
    // back with. A line total is qty x unit price, so it is not bounded the same way.
    if (line.unitPriceMillimes > MAX_PRICE_MILLIMES) {
      throw lineError(line.lineNo, 'A unit price cannot be above one billion dinars.');
    }
    return productId;
  }

  function checkSaleLines(profile: MemoryProfile, lines: readonly SaleLine[]): CheckedLines {
    let subtotal = 0n;
    let discount = 0n;
    let total = 0n;
    const stored = lines.map((line, index): SaleLine => {
      const productId = lineProductId(profile, line, index);
      if (line.refundsLineNo !== null) {
        throw lineError(line.lineNo, 'A sale line cannot refund another line.');
      }
      const qty = BigInt(line.qty);
      const unit = BigInt(line.unitPriceMillimes);
      const lineDiscount = BigInt(line.lineDiscountMillimes);
      const share = BigInt(line.cartDiscountShareMillimes);
      const lineTotal = BigInt(line.lineTotalMillimes);
      if (
        qty < 1n ||
        unit < 0n ||
        lineDiscount < 0n ||
        share < 0n ||
        lineDiscount + share > qty * unit ||
        lineTotal !== qty * unit - lineDiscount - share
      ) {
        throw lineError(line.lineNo, 'Line amounts do not add up.');
      }
      subtotal += qty * unit - lineDiscount;
      discount += share;
      total += lineTotal;
      return { ...line, productId };
    });
    return { lines: stored, subtotal, discount, total };
  }

  /**
   * Refund lines against `original`: each names one of its lines once, with the same product and
   * unit price, no discounts, and a negative quantity and amount within what is left; a refund of a
   * line's last units pays exactly what is left of it.
   */
  function checkRefundLines(
    profile: MemoryProfile,
    lines: readonly SaleLine[],
    original: SaleRow,
  ): CheckedLines {
    let total = 0n;
    const seen = new Set<number>();
    const stored = lines.map((line, index): SaleLine => {
      const productId = lineProductId(profile, line, index);
      const { refundsLineNo } = line;
      if (refundsLineNo === null) {
        throw invalidField('refunds_line_no', 'refunds_line_no must be a whole number.');
      }
      if (seen.has(refundsLineNo)) {
        throw lineError(line.lineNo, 'An original line can appear only once in a refund.');
      }
      seen.add(refundsLineNo);
      const sold = original.lines.find((candidate) => candidate.lineNo === refundsLineNo);
      if (!sold) {
        throw lineError(line.lineNo, 'A refund line names a line that is not on the sale.');
      }
      const qty = BigInt(line.qty);
      const lineTotal = BigInt(line.lineTotalMillimes);
      if (
        productId !== sold.productId ||
        line.unitPriceMillimes !== sold.unitPriceMillimes ||
        line.lineDiscountMillimes !== 0 ||
        line.cartDiscountShareMillimes !== 0 ||
        qty > -1n ||
        lineTotal > 0n
      ) {
        throw lineError(
          line.lineNo,
          'A refund line must match its sale line, with a negative quantity and amount.',
        );
      }
      const refunded = refundedOf(store, original.id, refundsLineNo);
      const remainingQty = BigInt(sold.qty - refunded.qty);
      const remainingMillimes = BigInt(sold.lineTotalMillimes) - BigInt(refunded.millimes);
      const details = {
        lineNo: line.lineNo,
        remainingQty: Number(remainingQty),
        remainingMillimes: Number(remainingMillimes),
      };
      if (-qty > remainingQty || -lineTotal > remainingMillimes) {
        throw new AppError(
          'VALIDATION_ERROR',
          'The refund is more than what is left to refund on this line.',
          { details },
        );
      }
      if (-qty === remainingQty && -lineTotal !== remainingMillimes) {
        throw new AppError(
          'VALIDATION_ERROR',
          'A refund of the last units of a line pays exactly what is left of it.',
          { details },
        );
      }
      total += lineTotal;
      return { ...line, productId };
    });
    return { lines: stored, subtotal: total, discount: 0n, total };
  }

  /** The sale a refund names: one of the caller's shop (NOT_FOUND otherwise), and not a refund. */
  function refundedSale(profile: MemoryProfile, refundsSaleId: string | null): SaleRow {
    if (refundsSaleId === null) {
      throw invalidField('refunds_sale_id', 'refunds_sale_id is required.');
    }
    const saleId = parseUuid(refundsSaleId, 'refunds_sale_id');
    const sale = store.sales.get(saleId);
    if (!sale || sale.shopId !== profile.shopId) {
      throw new AppError('NOT_FOUND', 'The sale to refund does not exist.', {
        details: { saleId },
      });
    }
    if (sale.kind !== 'sale') {
      throw invalidField('refunds_sale_id', 'Only a sale can be refunded, not a refund.');
    }
    return sale;
  }

  function recordBelongsElsewhere(): AppError {
    return new AppError('FORBIDDEN', 'This record belongs to another shop.');
  }

  function differentRecord(id: string, message: string): AppError {
    return new AppError('IDEMPOTENCY_CONFLICT', message, { details: { id } });
  }

  return {
    recordSale: (record) =>
      perform(context, 'sales.recordSale', (): RecordSaleResult => {
        const profile = requireProfile(context);
        const input = parseInput(saleRecordInput, record);
        const id = input.id.toLowerCase();
        const terminal = terminalFor(store, profile.shopId, input.terminalCode);

        // A record already recorded or voided returns its stored outcome, whatever changed since.
        const recorded = store.sales.get(id);
        if (recorded) {
          if (recorded.shopId !== profile.shopId) {
            throw recordBelongsElsewhere();
          }
          if (recorded.payloadHash !== input.payloadHash) {
            throw differentRecord(id, 'A different record was already stored under this id.');
          }
          return { saleId: id, receiptNumber: recorded.receiptNumber, status: 'replayed' };
        }
        const voided = store.receiptVoids.get(id);
        if (voided) {
          if (voided.shopId !== profile.shopId) {
            throw recordBelongsElsewhere();
          }
          if (voided.payloadHash !== input.payloadHash) {
            throw differentRecord(id, 'A different record was already stored under this id.');
          }
          return { saleId: id, receiptNumber: voided.receiptNumber, status: 'voided' };
        }

        requireEpoch(terminal, input.epoch);
        const session = sessionForRecord(profile, terminal, input.sessionId);
        requireNextSeq(
          terminal,
          input.seq,
          `Expected receipt ${receiptNumber(terminal.code, terminal.lastSeq + 1)}.`,
        );

        if (input.lines.length === 0) {
          throw invalidField('lines', 'A record needs at least one line.');
        }
        let checked: CheckedLines;
        let refundsSaleId: string | null = null;
        if (input.kind === 'refund') {
          const original = refundedSale(profile, input.refundsSaleId);
          refundsSaleId = original.id;
          checked = checkRefundLines(profile, input.lines, original);
        } else {
          if (input.refundsSaleId !== null) {
            throw invalidField('refunds_sale_id', 'Only a refund names a sale to refund.');
          }
          checked = checkSaleLines(profile, input.lines);
        }
        if (
          BigInt(input.subtotalMillimes) !== checked.subtotal ||
          BigInt(input.discountMillimes) !== checked.discount ||
          BigInt(input.totalMillimes) !== checked.total
        ) {
          throw new AppError('VALIDATION_ERROR', 'The document totals do not match its lines.', {
            details: {
              subtotalMillimes: Number(checked.subtotal),
              discountMillimes: Number(checked.discount),
              totalMillimes: Number(checked.total),
            },
          });
        }

        // Change only exists for cash; card payments and refunds are exactly the total.
        const { method, tenderedMillimes, changeMillimes } = input.payment;
        const { totalMillimes } = input;
        if (input.kind === 'refund' || method === 'card') {
          if (tenderedMillimes !== totalMillimes || changeMillimes !== 0) {
            throw invalidField(
              'payment',
              'Card payments and refunds are exactly the total, with no change.',
            );
          }
        } else if (
          tenderedMillimes < totalMillimes ||
          changeMillimes !== tenderedMillimes - totalMillimes
        ) {
          throw invalidField('payment', 'Change must be the amount tendered minus the total.');
        }

        const createdAt = parseTimestamp(input.createdAt, 'created_at');
        const receivedAt = context.now().toISOString();
        const number = receiptNumber(terminal.code, input.seq);
        const sale: SaleRow = {
          id,
          shopId: profile.shopId,
          terminalId: terminal.id,
          sessionId: session.id,
          kind: input.kind,
          seq: input.seq,
          receiptNumber: number,
          refundsSaleId,
          paymentMethod: method,
          subtotalMillimes: input.subtotalMillimes,
          discountMillimes: input.discountMillimes,
          totalMillimes,
          tenderedMillimes,
          changeMillimes,
          epoch: terminal.epoch,
          payloadHash: input.payloadHash,
          submittedBy: profile.userId,
          createdAt,
          receivedAt,
          lines: checked.lines,
        };
        store.sales.set(id, sale);
        // A sale takes units out of stock and a refund puts them back. Stock may go negative: a
        // sale that happened is never refused for stock.
        for (const line of sale.lines) {
          moveStock(store, {
            shopId: profile.shopId,
            productId: line.productId,
            delta: -line.qty,
            reason: sale.kind,
            saleId: id,
            note: '',
            createdBy: profile.userId,
            createdAt: receivedAt,
          });
        }
        store.terminals.set(terminal.id, { ...terminal, lastSeq: input.seq });
        return { saleId: id, receiptNumber: number, status: 'created' };
      }),

    listSales: (query) =>
      perform(context, 'sales.listSales', () => {
        const profile = requireProfile(context);
        const filters = parseInput(listSalesQuerySchema, query);
        const terminalId =
          filters.terminalId === undefined ? null : parseUuid(filters.terminalId, 'terminal_id');
        const sessionId =
          filters.sessionId === undefined ? null : parseUuid(filters.sessionId, 'session_id');
        const newestFirst = Array.from(store.sales.values())
          .filter(
            (sale) =>
              sale.shopId === profile.shopId &&
              (terminalId === null || sale.terminalId === terminalId) &&
              (sessionId === null || sale.sessionId === sessionId),
          )
          .reverse();
        return newestFirst
          .slice(0, filters.limit ?? newestFirst.length)
          .map((sale) => saleView(store, sale));
      }),

    getSale: (id) =>
      perform(context, 'sales.getSale', () => {
        const profile = requireProfile(context);
        const saleId = parseUuid(id, 'id');
        const sale = store.sales.get(saleId);
        if (!sale || sale.shopId !== profile.shopId) {
          throw new AppError('NOT_FOUND', 'The sale does not exist.', { details: { saleId } });
        }
        return saleView(store, sale);
      }),

    voidReceipt: (input) =>
      perform(context, 'sales.voidReceipt', (): VoidReceiptResult => {
        const profile = requireProfile(context, ['admin']);
        const { record, errorCode, reason } = parseInput(voidReceiptInput, input);
        const id = record.id.toLowerCase();
        if (reason.trim() === '') {
          throw invalidField('reason', 'Say why this receipt is being voided.');
        }
        const terminal = terminalFor(store, profile.shopId, record.terminalCode);

        // The record reached the ledger after all: acknowledged, but only if it is the same record.
        const recorded = store.sales.get(id);
        if (recorded) {
          if (recorded.shopId !== profile.shopId) {
            throw recordBelongsElsewhere();
          }
          if (recorded.payloadHash !== record.payloadHash) {
            throw differentRecord(id, 'A different record was already stored under this id.');
          }
          return { saleId: id, receiptNumber: recorded.receiptNumber, status: 'recorded' };
        }
        const voided = store.receiptVoids.get(id);
        if (voided) {
          if (voided.shopId !== profile.shopId) {
            throw recordBelongsElsewhere();
          }
          if (voided.payloadHash !== record.payloadHash) {
            throw differentRecord(id, 'A different record was already voided under this id.');
          }
          return { saleId: id, receiptNumber: voided.receiptNumber, status: 'replayed' };
        }

        requireNextSeq(
          terminal,
          record.seq,
          `Receipts are voided in order: the next one is ${receiptNumber(terminal.code, terminal.lastSeq + 1)}.`,
        );
        // The record may be malformed, which can be why it is voided: a session id that names no
        // session of this terminal leaves the void without a session.
        const sessionRef = parseRef(record.sessionId);
        const session = sessionRef === null ? undefined : store.sessions.get(sessionRef);
        const number = receiptNumber(terminal.code, record.seq);
        const receiptVoid: MemoryReceiptVoid = {
          id,
          shopId: profile.shopId,
          terminalId: terminal.id,
          sessionId: session?.terminalId === terminal.id ? session.id : null,
          seq: record.seq,
          receiptNumber: number,
          payload: record,
          payloadHash: record.payloadHash,
          errorCode,
          reason: reason.trim(),
          voidedBy: profile.userId,
          voidedAt: context.now().toISOString(),
        };
        store.receiptVoids.set(id, receiptVoid);
        store.terminals.set(terminal.id, { ...terminal, lastSeq: record.seq });
        return { saleId: id, receiptNumber: number, status: 'voided' };
      }),
  };
}
