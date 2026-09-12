import { z } from 'zod';
import { parseOrInvalid } from '@/lib/validation';
import {
  listSalesQuerySchema,
  recordSaleResultSchema,
  saleRecordSchema,
  saleSchema,
  voidReceiptInputSchema,
  voidReceiptResultSchema,
  type SalesPort,
} from '@/ports';
import type { RestClient } from './http';
import { pathSegment } from './paths';
import { fromWire, toWire, type WireSaleRecord, type WireVoidReceiptRequest } from './wire';
import { checkWriteOutcome } from './writes';

const salesSchema = z.array(saleSchema);

/**
 * SalesPort over /sales and /receipt-voids. A record is idempotent by its id: 201 says the ledger
 * took it now, 200 says it was already there — `replayed` with the same hash, or `voided` when an
 * admin gave up on that number (contracts/errors.md).
 */
export function createRestSales(client: RestClient): SalesPort {
  return {
    async recordSale(record) {
      const payload = parseOrInvalid(saleRecordSchema, record, 'the sale record');
      const response = await client.request('POST', '/sales', {
        body: toWire<WireSaleRecord>(payload),
      });
      const result = fromWire(recordSaleResultSchema, response.body, 'the recorded sale');
      checkWriteOutcome(response.status, result.status, 'created', 'a recorded sale');
      return result;
    },

    async listSales(query) {
      const { terminalId, sessionId, tableId, limit } = parseOrInvalid(
        listSalesQuerySchema,
        query,
        'the sales query',
      );
      const response = await client.request('GET', '/sales', {
        query: {
          terminal_id: terminalId,
          session_id: sessionId,
          table_id: tableId,
          limit,
        },
      });
      return fromWire(salesSchema, response.body, 'the sales');
    },

    async getSale(id) {
      const response = await client.request('GET', `/sales/${pathSegment(id, 'the sale id')}`);
      return fromWire(saleSchema, response.body, 'the sale');
    },

    async voidReceipt(input) {
      const payload = parseOrInvalid(voidReceiptInputSchema, input, 'the void');
      const response = await client.request('POST', '/receipt-voids', {
        body: toWire<WireVoidReceiptRequest>(payload),
      });
      const result = fromWire(voidReceiptResultSchema, response.body, 'the voided receipt');
      // 201 is the void this call made; 200 is a replay, or the record reaching the ledger after all.
      checkWriteOutcome(response.status, result.status, 'voided', 'a voided receipt');
      return result;
    },
  };
}
