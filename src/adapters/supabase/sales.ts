import { AppError } from '@/lib/errors';
import { add, mm, neg, ZERO, type Millimes } from '@/lib/money';
import {
  listSalesQuerySchema,
  recordSaleResultSchema,
  saleRecordSchema,
  saleSchema,
  voidReceiptInputSchema,
  voidReceiptResultSchema,
  type Sale,
  type SalesPort,
} from '@/ports';
import type { SupabaseDatabaseClient } from './client';
import type { Tables } from './database.types';
import { unwrap } from './errors';
import { parseInput, parseOutput } from './validate';
import { fromWire, toWire } from './wire';

const SALE_COLUMNS =
  'id, kind, seq, receipt_number, terminal_id, session_id, table_id, refunds_sale_id, payment_method, cart_discount_millimes, total_millimes, tendered_millimes, change_millimes, created_at, received_at, terminals(code), dining_tables(name), sale_lines(id, line_no, open_order_item_id, product_id, product_name, qty, unit_price_millimes, line_discount_millimes, line_discount_reason, allocated_discount_millimes, line_total_millimes, refunds_sale_line_id)';

const REFUND_COLUMNS =
  'refunds_sale_id, sale_lines(refunds_sale_line_id, qty, line_total_millimes)';

/** Sale ids per refund lookup, which keeps its URL far below any proxy's length limit. */
const REFUND_LOOKUP_BATCH = 50;

type SaleLineRow = Omit<Tables<'sale_lines'>, 'sale_id' | 'shop_id'>;

type SaleRow = Pick<
  Tables<'sales'>,
  | 'id'
  | 'kind'
  | 'seq'
  | 'receipt_number'
  | 'terminal_id'
  | 'session_id'
  | 'table_id'
  | 'refunds_sale_id'
  | 'payment_method'
  | 'cart_discount_millimes'
  | 'total_millimes'
  | 'tendered_millimes'
  | 'change_millimes'
  | 'created_at'
  | 'received_at'
> & {
  readonly terminals: { readonly code: string } | null;
  readonly dining_tables: { readonly name: string } | null;
  readonly sale_lines: readonly SaleLineRow[];
};

type RefundRow = Pick<Tables<'sales'>, 'refunds_sale_id'> & {
  readonly sale_lines: readonly Pick<
    Tables<'sale_lines'>,
    'refunds_sale_line_id' | 'qty' | 'line_total_millimes'
  >[];
};

interface Refunded {
  readonly qty: number;
  readonly millimes: Millimes;
}

/** What refunds took back of each sale line, keyed by the line's own id, as positive amounts. */
function refundedByLine(refunds: readonly RefundRow[]): Map<string, Refunded> {
  const refunded = new Map<string, Refunded>();
  for (const refund of refunds) {
    for (const line of refund.sale_lines) {
      if (line.refunds_sale_line_id === null) {
        continue;
      }
      const earlier = refunded.get(line.refunds_sale_line_id) ?? { qty: 0, millimes: ZERO };
      refunded.set(line.refunds_sale_line_id, {
        qty: earlier.qty - line.qty,
        millimes: add(earlier.millimes, neg(mm(line.line_total_millimes))),
      });
    }
  }
  return refunded;
}

function toSale(row: SaleRow, refunded: ReadonlyMap<string, Refunded>): Sale {
  const lines = [...row.sale_lines]
    .sort((a, b) => a.line_no - b.line_no)
    .map((line) => {
      // Only sales are refunded; the lines of a refund take nothing back.
      const taken = row.kind === 'sale' ? refunded.get(line.id) : undefined;
      return {
        id: line.id,
        lineNo: line.line_no,
        openOrderItemId: line.open_order_item_id,
        productId: line.product_id,
        productName: line.product_name,
        qty: line.qty,
        unitPriceMillimes: line.unit_price_millimes,
        lineDiscountMillimes: line.line_discount_millimes,
        lineDiscountReason: line.line_discount_reason,
        allocatedDiscountMillimes: line.allocated_discount_millimes,
        // `net_millimes` in the payload and in docs/spec.md; the column kept its original name.
        netMillimes: line.line_total_millimes,
        refundsSaleLineId: line.refunds_sale_line_id,
        refundedQty: taken?.qty ?? 0,
        refundedMillimes: taken?.millimes ?? ZERO,
      };
    });
  return parseOutput(
    saleSchema,
    {
      id: row.id,
      kind: row.kind,
      receiptNumber: row.receipt_number,
      seq: row.seq,
      terminalId: row.terminal_id,
      terminalCode: row.terminals?.code ?? '',
      sessionId: row.session_id,
      tableId: row.table_id,
      tableName: row.dining_tables?.name ?? null,
      refundsSaleId: row.refunds_sale_id,
      paymentMethod: row.payment_method,
      cartDiscountMillimes: row.cart_discount_millimes,
      totalMillimes: row.total_millimes,
      tenderedMillimes: row.tendered_millimes,
      changeMillimes: row.change_millimes,
      createdAt: row.created_at,
      receivedAt: row.received_at,
      lines,
    },
    `sale ${row.id}`,
  );
}

/**
 * SalesPort over record_sale and void_receipt, which apply the order of checks in
 * contracts/errors.md, and the sales and sale_lines tables, which nobody can change.
 */
export function createSupabaseSales(client: SupabaseDatabaseClient): SalesPort {
  async function refundsOf(saleIds: readonly string[]): Promise<RefundRow[]> {
    const batches: string[][] = [];
    for (let start = 0; start < saleIds.length; start += REFUND_LOOKUP_BATCH) {
      batches.push(saleIds.slice(start, start + REFUND_LOOKUP_BATCH));
    }
    const results = await Promise.all(
      batches.map((ids) =>
        unwrap(client.from('sales').select(REFUND_COLUMNS).in('refunds_sale_id', ids)),
      ),
    );
    return results.flat();
  }

  /** `rows` as port sales, with what refunds from any terminal or session took back of each line. */
  async function withRefunds(rows: readonly SaleRow[]): Promise<Sale[]> {
    const saleIds = rows.filter((row) => row.kind === 'sale').map((row) => row.id);
    const refunded = refundedByLine(saleIds.length === 0 ? [] : await refundsOf(saleIds));
    return rows.map((row) => toSale(row, refunded));
  }

  return {
    async recordSale(record) {
      const payload = parseInput(saleRecordSchema, record);
      const data = await unwrap(client.rpc('record_sale', { p: toWire(payload) }));
      return fromWire(recordSaleResultSchema, data, 'the recorded sale');
    },

    async listSales(query) {
      const { terminalId, sessionId, limit } = parseInput(listSalesQuerySchema, query);
      let request = client
        .from('sales')
        .select(SALE_COLUMNS)
        .order('received_at', { ascending: false })
        .order('seq', { ascending: false });
      if (terminalId !== undefined) {
        request = request.eq('terminal_id', terminalId);
      }
      if (sessionId !== undefined) {
        request = request.eq('session_id', sessionId);
      }
      if (limit !== undefined) {
        request = request.limit(limit);
      }
      return withRefunds(await unwrap(request));
    },

    async getSale(id) {
      const row = await unwrap(
        client.from('sales').select(SALE_COLUMNS).eq('id', id).maybeSingle(),
      );
      if (row === null) {
        throw new AppError('NOT_FOUND', 'The sale does not exist.', { details: { saleId: id } });
      }
      const [sale] = await withRefunds([row]);
      return sale;
    },

    async voidReceipt(input) {
      const payload = parseInput(voidReceiptInputSchema, input);
      const data = await unwrap(client.rpc('void_receipt', { p: toWire(payload) }));
      return fromWire(voidReceiptResultSchema, data, 'the voided receipt');
    },
  };
}
