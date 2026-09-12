import type { Backend } from '@/ports';
import type { OutboxRecord, OutboxResult, OutboxTransport } from './types';

/** Sends outbox records through the ports, so every backend adapter is reached the same way. */
export function createPortTransport(
  backend: Pick<Backend, 'sales' | 'sessions' | 'orders'>,
): OutboxTransport {
  return {
    async send(record: OutboxRecord): Promise<OutboxResult> {
      switch (record.kind) {
        case 'sale':
        case 'refund': {
          const result = await backend.sales.recordSale(record.payload);
          return { status: result.status, receiptNumber: result.receiptNumber };
        }
        case 'session_open': {
          const result = await backend.sessions.open(record.payload);
          return { status: result.status };
        }
        case 'session_close': {
          const result = await backend.sessions.close(record.payload);
          return { status: result.status, zReport: result.zReport };
        }
        case 'order_item_add': {
          const result = await backend.orders.addItem(record.payload);
          return { status: result.status, orderId: result.orderId };
        }
        case 'order_item_remove': {
          const result = await backend.orders.removeItem(record.payload);
          return { status: result.status, orderId: result.orderId, affected: result.affected };
        }
        case 'order_send': {
          const result = await backend.orders.send(record.payload);
          return { status: result.status, orderId: result.orderId, affected: result.affected };
        }
        case 'order_item_prepare': {
          const result = await backend.orders.prepareItem(record.payload);
          return { status: result.status, orderId: result.orderId, affected: result.affected };
        }
        case 'order_cancel': {
          const result = await backend.orders.cancelOrder(record.payload);
          return { status: result.status, orderId: result.orderId, affected: result.affected };
        }
      }
    },
  };
}
