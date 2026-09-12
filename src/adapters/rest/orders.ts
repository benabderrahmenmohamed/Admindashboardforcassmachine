import { z } from 'zod';
import { parseOrInvalid } from '@/lib/validation';
import {
  diningTableInputSchema,
  diningTableSchema,
  kitchenTicketSchema,
  openOrderSchema,
  orderCancelRecordSchema,
  orderItemAddRecordSchema,
  orderItemAddResultSchema,
  orderItemPrepareRecordSchema,
  orderItemRemoveRecordSchema,
  orderSendRecordSchema,
  orderWriteResultSchema,
  removedAfterSentQuerySchema,
  removedAfterSentSchema,
  tableBoardEntrySchema,
  type OrdersPort,
} from '@/ports';
import type { RestClient } from './http';
import { pathSegment } from './paths';
import {
  fromWire,
  toWire,
  type WireDiningTableInput,
  type WireOrderCancelRecord,
  type WireOrderItemAddRecord,
  type WireOrderItemPrepareRecord,
  type WireOrderItemRemoveRecord,
  type WireOrderSendRecord,
} from './wire';
import { checkWriteOutcome } from './writes';

const tablesSchema = z.array(diningTableSchema);
const boardSchema = z.array(tableBoardEntrySchema);
const ticketsSchema = z.array(kitchenTicketSchema);
const removedSchema = z.array(removedAfterSentSchema);
/** A free table has no open order, and the API says so with a null body rather than a 404. */
const openOrderOrNoneSchema = openOrderSchema.nullable();

/**
 * OrdersPort over the table and order-event paths of contracts/openapi.yaml. What is on the tables
 * right now is working state, not the ledger; the ledger takes over at payment (sales.ts).
 *
 * Every write is a record a device wrote, possibly offline, and may arrive twice: the record goes
 * out as it was written, so the server recognises a replay by its id and payload hash and answers
 * 200 with the stored outcome where a first write answers 201. A write names the table, never an
 * order, so two devices adding to the same free table cannot race on creating one — which is why an
 * add posts to the collection of items rather than to an order of its own.
 */
export function createRestOrders(client: RestClient): OrdersPort {
  /** The path of one table's sub-resource: its open order, its sends, its cancellations. */
  function tablePath(tableId: string, suffix = ''): string {
    return `/dining-tables/${pathSegment(tableId, 'the table id')}${suffix}`;
  }

  /** The path of one order item's sub-resource: its removals, its preparations. */
  function itemPath(itemId: string, suffix: string): string {
    return `/order-items/${pathSegment(itemId, 'the item id')}${suffix}`;
  }

  return {
    async listTables() {
      const response = await client.request('GET', '/dining-tables');
      return fromWire(tablesSchema, response.body, 'the tables');
    },

    async createTable(input) {
      const fields = parseOrInvalid(diningTableInputSchema, input, 'the table');
      const response = await client.request('POST', '/dining-tables', {
        body: toWire<WireDiningTableInput>(fields),
      });
      return fromWire(diningTableSchema, response.body, 'the created table');
    },

    async updateTable(id, input) {
      const fields = parseOrInvalid(diningTableInputSchema, input, 'the table');
      const response = await client.request('PUT', tablePath(id), {
        body: toWire<WireDiningTableInput>(fields),
      });
      return fromWire(diningTableSchema, response.body, 'the saved table');
    },

    async board() {
      const response = await client.request('GET', '/table-board');
      return fromWire(boardSchema, response.body, 'the table board');
    },

    async openOrder(tableId) {
      const response = await client.request('GET', tablePath(tableId, '/open-order'));
      return fromWire(openOrderOrNoneSchema, response.body, "the table's open order");
    },

    async kitchenTickets() {
      const response = await client.request('GET', '/kitchen-tickets');
      return fromWire(ticketsSchema, response.body, 'the kitchen tickets');
    },

    async removedAfterSent(query) {
      const { from, to } = parseOrInvalid(removedAfterSentQuerySchema, query, 'the report period');
      const response = await client.request('GET', '/reports/removed-after-sent-items', {
        query: { from, to },
      });
      return fromWire(removedSchema, response.body, 'the removed items report');
    },

    async addItem(record) {
      const payload = parseOrInvalid(orderItemAddRecordSchema, record, 'the add record');
      // The record names the table; the server finds its open order or opens one.
      const response = await client.request('POST', '/order-items', {
        body: toWire<WireOrderItemAddRecord>(payload),
      });
      const result = fromWire(orderItemAddResultSchema, response.body, 'the added item');
      checkWriteOutcome(response.status, result.status, 'created', 'an added item');
      return result;
    },

    async removeItem(record) {
      const payload = parseOrInvalid(orderItemRemoveRecordSchema, record, 'the removal record');
      const response = await client.request('POST', itemPath(payload.itemId, '/removals'), {
        body: toWire<WireOrderItemRemoveRecord>(payload),
      });
      const result = fromWire(orderWriteResultSchema, response.body, 'the removed item');
      checkWriteOutcome(response.status, result.status, 'created', 'a removed item');
      return result;
    },

    async send(record) {
      const payload = parseOrInvalid(orderSendRecordSchema, record, 'the send record');
      const response = await client.request('POST', tablePath(payload.tableId, '/sends'), {
        body: toWire<WireOrderSendRecord>(payload),
      });
      const result = fromWire(orderWriteResultSchema, response.body, 'the sent items');
      checkWriteOutcome(response.status, result.status, 'created', 'a send');
      return result;
    },

    async prepareItem(record) {
      const payload = parseOrInvalid(orderItemPrepareRecordSchema, record, 'the prepare record');
      const response = await client.request('POST', itemPath(payload.itemId, '/preparations'), {
        body: toWire<WireOrderItemPrepareRecord>(payload),
      });
      const result = fromWire(orderWriteResultSchema, response.body, 'the prepared item');
      checkWriteOutcome(response.status, result.status, 'created', 'a prepared item');
      return result;
    },

    async cancelOrder(record) {
      const payload = parseOrInvalid(orderCancelRecordSchema, record, 'the cancel record');
      const response = await client.request('POST', tablePath(payload.tableId, '/cancellations'), {
        body: toWire<WireOrderCancelRecord>(payload),
      });
      const result = fromWire(orderWriteResultSchema, response.body, 'the cancelled order');
      checkWriteOutcome(response.status, result.status, 'created', 'a cancelled order');
      return result;
    },
  };
}
