/**
 * The sales list of one terminal as the register shows it: the documents the server holds, plus the
 * ones this device wrote that have not reached it yet, each with how far it got. Kept out of the
 * components so it runs without a DOM.
 */
import { isNumbered, syncStatus, type NumberedRecord, type SyncStatus } from '@/features/pos/queue';
import { receiptNumber } from '@/features/sales/records';
import type { OutboxMeta, OutboxRecord } from '@/features/sync/types';
import { add, neg, ZERO } from '@/lib/money';
import type { Sale, SaleLineView } from '@/ports';

export interface SaleRow {
  readonly sale: Sale;
  readonly syncStatus: SyncStatus;
  /** The queue record behind a document the server has not taken yet, for its error and its state. */
  readonly record: NumberedRecord | null;
}

/**
 * A record this device wrote, as the ledger will hold it. The receipt number is the one allocated
 * when the record was written, so it is the number on the printed receipt either way. `receivedAt`
 * is the device's own time until the server answers with its own, which it alone is trusted for.
 */
export function localSaleView(meta: OutboxMeta, record: NumberedRecord): Sale {
  const { payload } = record;
  return {
    id: payload.id,
    kind: payload.kind,
    receiptNumber: receiptNumber(payload.terminalCode, payload.seq),
    seq: payload.seq,
    terminalId: meta.terminalId,
    terminalCode: payload.terminalCode,
    sessionId: payload.sessionId,
    refundsSaleId: payload.refundsSaleId,
    paymentMethod: payload.payment.method,
    subtotalMillimes: payload.subtotalMillimes,
    discountMillimes: payload.discountMillimes,
    totalMillimes: payload.totalMillimes,
    tenderedMillimes: payload.payment.tenderedMillimes,
    changeMillimes: payload.payment.changeMillimes,
    createdAt: payload.createdAt,
    receivedAt: payload.createdAt,
    lines: payload.lines.map((line): SaleLineView => ({
      ...line,
      refundedQty: 0,
      refundedMillimes: ZERO,
    })),
  };
}

/**
 * `sale` with the refunds this device wrote against it that the server has not listed yet counted
 * into each line. Without this a cashier could refund the same units twice while offline, and the
 * second refund would be refused on replay. Refund lines carry negative quantities and amounts.
 */
export function withLocalRefunds(sale: Sale, refunds: readonly NumberedRecord[]): Sale {
  const against = refunds.filter((record) => record.payload.refundsSaleId === sale.id);
  if (against.length === 0) {
    return sale;
  }
  return {
    ...sale,
    lines: sale.lines.map((line): SaleLineView => {
      const taken = against.flatMap((record) =>
        record.payload.lines.filter((refundLine) => refundLine.refundsLineNo === line.lineNo),
      );
      return {
        ...line,
        refundedQty: taken.reduce((qty, refundLine) => qty - refundLine.qty, line.refundedQty),
        refundedMillimes: add(
          line.refundedMillimes,
          ...taken.map((refundLine) => neg(refundLine.lineTotalMillimes)),
        ),
      };
    }),
  };
}

/**
 * The server's documents and this device's queue in one list, newest receipt first. A record the
 * server already lists is dropped in favour of the server's row, which is the one that also carries
 * what later refunds took back; every other record is shown from the copy this device kept.
 */
export function mergeSales(
  meta: OutboxMeta,
  serverSales: readonly Sale[],
  records: readonly OutboxRecord[],
): SaleRow[] {
  const onServer = new Set(serverSales.map((sale) => sale.id));
  const local = records
    .filter(isNumbered)
    .filter((record) => record.terminalCode === meta.code && !onServer.has(record.payload.id));
  // A voided record is not in the ledger, so it takes nothing back from the sale it names.
  const refunds = local.filter(
    (record) => record.payload.kind === 'refund' && record.status !== 'voided',
  );
  const rows: SaleRow[] = [
    ...serverSales.map((sale) => ({ sale, syncStatus: 'synced' as const, record: null })),
    ...local.map((record) => ({
      sale: localSaleView(meta, record),
      syncStatus: syncStatus(record),
      record,
    })),
  ];
  return rows
    .map((row) => ({ ...row, sale: withLocalRefunds(row.sale, refunds) }))
    .sort((a, b) => b.sale.seq - a.sale.seq);
}

export function findRow(rows: readonly SaleRow[], saleId: string): SaleRow | null {
  return rows.find((row) => row.sale.id === saleId) ?? null;
}
