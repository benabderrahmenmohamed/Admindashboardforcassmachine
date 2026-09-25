<?php

declare(strict_types=1);

namespace App\Tests\Api;

/**
 * What a test about money needs before it can test anything: a registered terminal, a drawer open on
 * it, and records shaped the way a register writes them - the lines adding up, the payment matching
 * the total, the number following the last one printed.
 *
 * The terminal is registered by the test rather than taken from the demo café, so nothing here
 * depends on the epoch or the receipt counter another test left behind.
 */
abstract class MoneyTestCase extends ApiTestCase
{
    protected const TABLE_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01';
    protected const EXPRESS = '55555555-5555-4555-8555-555555555505';
    protected const CROISSANT = '55555555-5555-4555-8555-555555555510';
    /** Counted, and 120 of them on the shelf. */
    protected const WATER = '55555555-5555-4555-8555-555555555501';
    protected const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    protected const CASHIER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

    /** This device is the terminal from now on, and takes over its receipt counter. */
    protected function register(string $code = 'C1', ?string $token = null): array
    {
        $terminal = $this->call('POST', '/api/v1/terminals/' . $code . '/registrations', $token ?? $this->tokenFor(self::ADMIN));
        self::assertSame(201, $this->httpStatus(), 'registering should work: ' . json_encode($terminal));

        return $terminal;
    }

    protected function openSession(array $terminal, int $float = 20000, ?string $token = null): array
    {
        $opened = $this->call('POST', '/api/v1/cash-sessions', $token ?? $this->tokenFor(self::CASHIER), $this->openRecord($terminal, $float));
        self::assertSame(201, $this->httpStatus(), 'opening a drawer should work: ' . json_encode($opened));

        return $opened;
    }

    /** A registered terminal with a drawer open on it, as a caisse has after signing in. */
    protected function caisse(string $code = 'C1', int $float = 20000): array
    {
        $terminal = $this->register($code);

        return $terminal + ['session_id' => $this->openSession($terminal, $float)['session_id']];
    }

    protected function openRecord(array $terminal, int $float = 20000, array $over = []): array
    {
        return $over + [
            'id' => $this->nextId(),
            'terminal_code' => $terminal['code'],
            'epoch' => $terminal['epoch'],
            'actor_user_id' => self::CASHIER_ID,
            'opened_at' => $this->moment(),
            'opening_float_millimes' => $float,
            'payload_hash' => $this->nextHash(),
        ];
    }

    protected function closeRecord(array $caisse, int $counted, array $over = []): array
    {
        return $over + [
            'id' => $this->nextId(),
            'session_id' => $caisse['session_id'],
            'terminal_code' => $caisse['code'],
            'epoch' => $caisse['epoch'],
            'actor_user_id' => self::CASHIER_ID,
            'closed_at' => $this->moment(),
            'closing_counted_millimes' => $counted,
            'client_z_report' => null,
            'payload_hash' => $this->nextHash(),
        ];
    }

    /** One line of a receipt. Its row id is the device's to choose, as the contract says. */
    protected function line(int $no, string $productId, string $name, int $qty, int $unit, array $over = []): array
    {
        return $over + [
            'id' => $this->nextId(),
            'line_no' => $no,
            'open_order_item_id' => null,
            'product_id' => $productId,
            'product_name' => $name,
            'qty' => $qty,
            'unit_price_millimes' => $unit,
            'line_discount_millimes' => 0,
            'line_discount_reason' => null,
            'allocated_discount_millimes' => 0,
            'net_millimes' => $qty * $unit,
            'refunds_sale_line_id' => null,
        ];
    }

    /**
     * A receipt as a register writes it: paid in cash, exactly the total, with the number that follows
     * the last one this terminal printed.
     */
    protected function saleRecord(array $caisse, int $seq, array $lines, array $over = []): array
    {
        $total = array_sum(array_column($lines, 'net_millimes'));

        return $over + [
            'id' => $this->nextId(),
            'kind' => 'sale',
            'terminal_code' => $caisse['code'],
            'epoch' => $caisse['epoch'],
            'seq' => $seq,
            'session_id' => $caisse['session_id'],
            'table_id' => null,
            'created_at' => $this->moment(),
            'lines' => $lines,
            'cart_discount_millimes' => 0,
            'total_millimes' => $total,
            'payment' => ['method' => 'cash', 'tendered_millimes' => $total, 'change_millimes' => 0],
            'refunds_sale_id' => null,
            'payload_hash' => $this->nextHash(),
        ];
    }

    /** The same receipt, given back: the lines it names, negative, and nothing else. */
    protected function refundRecord(array $caisse, int $seq, array $sale, array $lines): array
    {
        return $this->saleRecord($caisse, $seq, $lines, [
            'kind' => 'refund',
            'refunds_sale_id' => $sale['id'],
        ]);
    }

    /** A refund of one sale line, whole or in part. */
    protected function refundLine(int $no, array $line, int $qty): array
    {
        $back = intdiv($line['net_millimes'] * $qty, $line['qty']);

        return $this->line($no, $line['product_id'], $line['product_name'], -$qty, $line['unit_price_millimes'], [
            'net_millimes' => -$back,
            'refunds_sale_line_id' => $line['id'],
        ]);
    }

    protected function recordSale(array $record, ?string $token = null): array
    {
        return $this->call('POST', '/api/v1/sales', $token ?? $this->tokenFor(self::CASHIER), $record);
    }

    /** An item on a table, so there is something for a caisse to be paid for. */
    protected function addToTable(string $tableId, string $productId, int $qty = 1, ?string $token = null): array
    {
        $added = $this->call('POST', '/api/v1/order-items', $token ?? $this->tokenFor(self::WAITER), $this->record([
            'table_id' => $tableId,
            'product_id' => $productId,
            'qty' => $qty,
            'note' => '',
        ]));
        self::assertSame(201, $this->httpStatus(), 'putting an item on a table should work: ' . json_encode($added));

        return $added;
    }
}
