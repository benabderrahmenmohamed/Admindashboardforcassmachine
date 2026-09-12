import { receiptNumber } from '@/features/sales/records';
import { AppError } from '@/lib/errors';
import {
  listSalesQuerySchema,
  MAX_PRICE_MILLIMES,
  type RecordSaleResult,
  type Role,
  type SalesPort,
  type VoidReceiptResult,
} from '@/ports';
import { refundedOf, requireEpoch, requireNextSeq, saleView, terminalFor } from './ledger';
import { closeIfSettled } from './orders';
import type { MemoryProfile } from './seed';
import { saleRecordInput, voidReceiptInput, type SaleLineInput } from './shapes';
import {
  moveStock,
  type MemoryReceiptVoid,
  type MemoryTerminal,
  type OpenOrderItemRow,
  type SaleLineRow,
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
  readonly lines: SaleLineRow[];
  readonly discount: bigint;
  readonly total: bigint;
  /** The open order items this document pays, in line order; empty when it pays no table. */
  readonly paid: readonly OpenOrderItemRow[];
}

function lineError(lineNo: number, message: string): AppError {
  return new AppError('VALIDATION_ERROR', message, { details: { lineNo } });
}

/**
 * Who may take money. A waiter works the tables but does not record sales or refunds: the counter
 * does, on a registered terminal with an open session of its own.
 */
const SELL_ROLES: readonly Role[] = ['admin', 'cashier'];

/**
 * The sales ledger, as record_sale and void_receipt, in their order of checks (contracts/errors.md):
 * caller, terminal, replay, registration, session, numbering, then the document recomputed from its
 * lines. A cashier or an admin records; only an admin voids. Amounts are checked in bigint, like the
 * database's bigint columns, so no sum ever leaves the safe integers unnoticed.
 *
 * Paying a table is one sale for a set of that table's active, unpaid items: each line names the
 * item it pays, the items are stamped with the sale, and the order closes when nothing unpaid is
 * left on it — so a table can pay in parts, and what the register saw must still be there.
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

  /** The line as the ledger stores it, under the id the device that wrote it gave it. */
  function storedLine(line: SaleLineInput, productId: string): SaleLineRow {
    return {
      id: parseUuid(line.id, 'id'),
      lineNo: line.lineNo,
      openOrderItemId: line.openOrderItemId,
      productId,
      productName: line.productName,
      qty: line.qty,
      unitPriceMillimes: line.unitPriceMillimes,
      lineDiscountMillimes: line.lineDiscountMillimes,
      lineDiscountReason: line.lineDiscountReason,
      allocatedDiscountMillimes: line.allocatedDiscountMillimes,
      netMillimes: line.netMillimes,
      refundsSaleLineId: line.refundsSaleLineId,
    };
  }

  function orderChanged(lineNo: number, itemId: string, item: OpenOrderItemRow | null): AppError {
    const tableId = item === null ? null : (store.openOrders.get(item.orderId)?.tableId ?? null);
    return new AppError(
      'ORDER_CHANGED',
      'This table changed while it was being paid for. Look at it again.',
      { details: { lineNo, itemId, orderId: item?.orderId ?? null, tableId } },
    );
  }

  /**
   * The open order item a sale line pays, or null on a line that pays no table. The item has to be
   * where the register last saw it: on an open order of this shop, still there, not yet paid, and
   * the same product, quantity and unit price. Anything else means the table moved under the
   * request — somebody added, removed or paid meanwhile — so the terminal refreshes and pays again.
   */
  function paidItem(
    profile: MemoryProfile,
    line: SaleLineInput,
    productId: string,
  ): OpenOrderItemRow | null {
    const reference = line.openOrderItemId ?? null;
    if (reference === null) {
      return null;
    }
    const itemId = parseUuid(reference, 'open_order_item_id');
    const item = store.openOrderItems.get(itemId);
    if (!item || item.shopId !== profile.shopId) {
      throw orderChanged(line.lineNo, itemId, null);
    }
    if (
      item.removedAt !== null ||
      item.paidSaleId !== null ||
      store.openOrders.get(item.orderId)?.status !== 'open' ||
      item.productId !== productId ||
      item.qty !== line.qty ||
      item.unitPriceMillimes !== line.unitPriceMillimes
    ) {
      throw orderChanged(line.lineNo, itemId, item);
    }
    return item;
  }

  /**
   * The table a sale is paid at, checked against the items its lines pay.
   *
   * A counter sale names no table and pays no order item: a coffee taken away sat on nothing. A
   * table payment names the table, and every item it pays has to be on that table's open order, so
   * a stale receipt cannot settle rows of the table next to it. The two mix on one bill — the guest
   * at table 4 who also buys a packet of cigarettes off the counter — and the counter lines simply
   * pay no item: nothing is lost either way, since only a named item is marked paid.
   */
  function tableForPayment(
    profile: MemoryProfile,
    reference: string | null,
    paid: readonly OpenOrderItemRow[],
  ): string | null {
    const [first] = paid;
    if (reference === null) {
      if (first) {
        throw invalidField('table_id', 'A sale that pays a table must name it.');
      }
      return null;
    }
    const tableId = parseUuid(reference, 'table_id');
    const table = store.diningTables.get(tableId);
    if (!table || table.shopId !== profile.shopId) {
      throw new AppError('NOT_FOUND', 'The table does not exist.', { details: { tableId } });
    }
    // A retired table is still paid for: the guests sitting there when it was retired still owe.
    if (first && store.openOrders.get(first.orderId)?.tableId !== tableId) {
      throw new AppError(
        'ORDER_CHANGED',
        'These items are not on the table this sale names. Look at it again.',
        { details: { tableId, itemId: first.id, orderId: first.orderId } },
      );
    }
    return tableId;
  }

  /**
   * Lines numbered 1, 2, 3, naming products of the shop (archived ones included) at a unit price
   * within the product bound: what record_sale checks for a line of either kind, in its order.
   */
  function lineProductId(profile: MemoryProfile, line: SaleLineInput, index: number): string {
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

  function checkSaleLines(profile: MemoryProfile, lines: readonly SaleLineInput[]): CheckedLines {
    let discount = 0n;
    let total = 0n;
    const paid: OpenOrderItemRow[] = [];
    const stored = lines.map((line, index): SaleLineRow => {
      const productId = lineProductId(profile, line, index);
      if (line.refundsSaleLineId !== null) {
        throw lineError(line.lineNo, 'A sale line cannot refund another line.');
      }
      // Money off a bill is a decision somebody made, so it is never anonymous.
      if (line.lineDiscountMillimes !== 0 && (line.lineDiscountReason ?? '').trim() === '') {
        throw lineError(line.lineNo, 'A line discount needs a reason.');
      }
      if (paid.some((other) => other.id === line.openOrderItemId)) {
        throw lineError(line.lineNo, 'An order item can appear on only one line.');
      }
      const item = paidItem(profile, line, productId);
      if (item) {
        // One sale pays one table: a line naming an item of another order is a stale receipt.
        const [first] = paid;
        if (first && first.orderId !== item.orderId) {
          throw orderChanged(line.lineNo, item.id, item);
        }
        paid.push(item);
      }
      const qty = BigInt(line.qty);
      const unit = BigInt(line.unitPriceMillimes);
      const lineDiscount = BigInt(line.lineDiscountMillimes);
      const share = BigInt(line.allocatedDiscountMillimes);
      const net = BigInt(line.netMillimes);
      if (
        qty < 1n ||
        unit < 0n ||
        lineDiscount < 0n ||
        share < 0n ||
        lineDiscount + share > qty * unit ||
        net !== qty * unit - lineDiscount - share
      ) {
        throw lineError(line.lineNo, 'Line amounts do not add up.');
      }
      discount += share;
      total += net;
      return storedLine(line, productId);
    });
    return { lines: stored, discount, total, paid };
  }

  /**
   * Refund lines against `original`: each names one of its lines once, with the same product and
   * unit price, no discounts, and a negative quantity and amount within what is left; a refund of a
   * line's last units pays exactly what is left of it.
   */
  function checkRefundLines(
    profile: MemoryProfile,
    lines: readonly SaleLineInput[],
    original: SaleRow,
  ): CheckedLines {
    let total = 0n;
    const seen = new Set<string>();
    const stored = lines.map((line, index): SaleLineRow => {
      const productId = lineProductId(profile, line, index);
      const { refundsSaleLineId } = line;
      if (refundsSaleLineId === null) {
        throw invalidField('refunds_sale_line_id', 'refunds_sale_line_id is required.');
      }
      if (seen.has(refundsSaleLineId)) {
        throw lineError(line.lineNo, 'An original line can appear only once in a refund.');
      }
      seen.add(refundsSaleLineId);
      const sold = original.lines.find((candidate) => candidate.id === refundsSaleLineId);
      if (!sold) {
        throw lineError(line.lineNo, 'A refund line names a line that is not on the sale.');
      }
      const qty = BigInt(line.qty);
      const net = BigInt(line.netMillimes);
      if (
        productId !== sold.productId ||
        line.unitPriceMillimes !== sold.unitPriceMillimes ||
        line.lineDiscountMillimes !== 0 ||
        line.allocatedDiscountMillimes !== 0 ||
        line.openOrderItemId !== null ||
        qty > -1n ||
        net > 0n
      ) {
        throw lineError(
          line.lineNo,
          'A refund line must match its sale line, with a negative quantity and amount.',
        );
      }
      const refunded = refundedOf(store, original.id, refundsSaleLineId);
      const remainingQty = BigInt(sold.qty - refunded.qty);
      const remainingMillimes = BigInt(sold.netMillimes) - BigInt(refunded.millimes);
      const details = {
        lineNo: line.lineNo,
        remainingQty: Number(remainingQty),
        remainingMillimes: Number(remainingMillimes),
      };
      if (-qty > remainingQty || -net > remainingMillimes) {
        throw new AppError(
          'VALIDATION_ERROR',
          'The refund is more than what is left to refund on this line.',
          { details },
        );
      }
      if (-qty === remainingQty && -net !== remainingMillimes) {
        throw new AppError(
          'VALIDATION_ERROR',
          'A refund of the last units of a line pays exactly what is left of it.',
          { details },
        );
      }
      total += net;
      return storedLine(line, productId);
    });
    // A refund never touches a table: the items it gives money back for were paid and are gone
    // from the order, and putting them back would sell them twice.
    return { lines: stored, discount: 0n, total, paid: [] };
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
        // Refunds need a cashier or an admin, and so does a sale: the same people take the money.
        const profile = requireProfile(context, SELL_ROLES);
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
          if (input.tableId !== null) {
            throw invalidField('table_id', 'A refund is not paid at a table.');
          }
          checked = checkRefundLines(profile, input.lines, original);
        } else {
          if (input.refundsSaleId !== null) {
            throw invalidField('refunds_sale_id', 'Only a refund names a sale to refund.');
          }
          checked = checkSaleLines(profile, input.lines);
        }
        const tableId = tableForPayment(profile, input.tableId, checked.paid);
        if (
          BigInt(input.cartDiscountMillimes) !== checked.discount ||
          BigInt(input.totalMillimes) !== checked.total
        ) {
          throw new AppError('VALIDATION_ERROR', 'The document totals do not match its lines.', {
            details: {
              cartDiscountMillimes: Number(checked.discount),
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
          tableId,
          paymentMethod: method,
          cartDiscountMillimes: input.cartDiscountMillimes,
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
        // The items this sale paid carry the link to it, and their table is free again once
        // nothing unpaid is left on it: a table that pays in parts stays open until it is.
        for (const item of checked.paid) {
          store.openOrderItems.set(item.id, { ...item, paidSaleId: id });
        }
        const [first] = checked.paid;
        if (first) {
          if (closeIfSettled(store, first.orderId, receivedAt)) {
            context.emit(profile.shopId, 'open_orders');
          }
          context.emit(profile.shopId, 'open_order_items');
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
