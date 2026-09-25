<?php

declare(strict_types=1);

namespace App\Tests\Api;

/**
 * The ledger over HTTP: what was paid, what was given back, and the numbers nobody could use.
 *
 * A receipt number is the one thing a café cannot fudge, so these tests hold the two rules that keep
 * it honest: a terminal's numbers follow one another with no gaps, and a record that arrives twice is
 * one sale. Everything a bill says is recomputed from its lines by the database; what is tested here
 * is that the server carries the record as written, answers the right status, and reads the ledger
 * back in the shape the caisse and the receipt need.
 */
final class LedgerTest extends MoneyTestCase
{
    public function testASaleOffATableIsNumberedPaysItsItemsAndFreesTheTable(): void
    {
        $caisse = $this->caisse('C1');
        $coffee = $this->addToTable(self::TABLE_1, self::EXPRESS, 2);
        $cake = $this->addToTable(self::TABLE_1, self::CROISSANT, 1);

        $recorded = $this->recordSale($this->saleRecord($caisse, 1, [
            $this->line(1, self::EXPRESS, 'Express', 2, 1200, ['open_order_item_id' => $coffee['item_id']]),
            $this->line(2, self::CROISSANT, 'Croissant', 1, 1200, ['open_order_item_id' => $cake['item_id']]),
        ], ['table_id' => self::TABLE_1]));

        self::assertSame(201, $this->httpStatus());
        self::assertSame('created', $recorded['status']);
        self::assertSame('C1-1', $recorded['receipt_number'], 'the first receipt of a terminal that had printed none');

        $cashier = $this->tokenFor(self::CASHIER);
        $sale = $this->call('GET', '/api/v1/sales/' . $recorded['sale_id'], $cashier);
        self::assertSame(200, $this->httpStatus());
        self::assertSame('C1', $sale['terminal_code']);
        self::assertSame('Table 1', $sale['table_name'], 'so a receipt read back later still says where it was paid');
        self::assertSame('sale', $sale['kind']);
        self::assertSame(3600, $sale['total_millimes']);
        self::assertSame(1, $sale['seq']);
        self::assertSame(['Express', 'Croissant'], array_column($sale['lines'], 'product_name'));
        self::assertSame([
            'allocated_discount_millimes' => 0,
            'id' => $sale['lines'][0]['id'],
            'line_discount_millimes' => 0,
            'line_discount_reason' => null,
            'line_no' => 1,
            'net_millimes' => 2400,
            'open_order_item_id' => $coffee['item_id'],
            'product_id' => self::EXPRESS,
            'product_name' => 'Express',
            'qty' => 2,
            'refunded_millimes' => 0,
            'refunded_qty' => 0,
            'refunds_sale_line_id' => null,
            'unit_price_millimes' => 1200,
        ], $this->sorted($sale['lines'][0]));

        self::assertSame([$sale], $this->call('GET', '/api/v1/sales', $cashier, null, ['terminal_id' => $caisse['terminal_id']]));

        $this->call('GET', '/api/v1/dining-tables/' . self::TABLE_1 . '/open-order', $cashier);
        self::assertNull($this->answer(), 'nothing is left unpaid on the table, so its order is closed');
    }

    public function testTheSameSaleRecordTwiceIsOneSaleAndTwoAnswers(): void
    {
        $caisse = $this->caisse('C1');
        $record = $this->saleRecord($caisse, 1, [$this->line(1, self::EXPRESS, 'Express', 1, 1200)]);

        $first = $this->recordSale($record);
        self::assertSame(201, $this->httpStatus());

        $again = $this->recordSale($record);
        self::assertSame(200, $this->httpStatus());
        self::assertSame('replayed', $again['status']);
        self::assertSame($first['receipt_number'], $again['receipt_number']);

        self::assertCount(1, $this->call('GET', '/api/v1/sales', $this->tokenFor(self::CASHIER), null, [
            'terminal_id' => $caisse['terminal_id'],
        ]), 'a till that sends the same receipt twice has sold once');
    }

    public function testANumberOutOfOrderIsRefusedWithTheNumberItExpected(): void
    {
        $caisse = $this->caisse('C1');

        $answer = $this->recordSale($this->saleRecord($caisse, 5, [$this->line(1, self::EXPRESS, 'Express', 1, 1200)]));

        self::assertSame(409, $this->httpStatus());
        self::assertSame('SEQUENCE_GAP', $this->errorCode($answer));
        self::assertSame(1, $answer['error']['details']['expected_seq']);
        self::assertSame(5, $answer['error']['details']['received_seq']);
    }

    public function testARefundGivesBackPartOfASaleAndTheSaleSaysHowMuch(): void
    {
        $caisse = $this->caisse('C1');
        $line = $this->line(1, self::EXPRESS, 'Express', 2, 1200);
        $sold = $this->saleRecord($caisse, 1, [$line]);
        $sale = $this->recordSale($sold);
        self::assertSame(201, $this->httpStatus());

        $refund = $this->recordSale($this->refundRecord($caisse, 2, $sold, [$this->refundLine(1, $line, 1)]));
        self::assertSame(201, $this->httpStatus());
        self::assertSame('C1-2', $refund['receipt_number'], 'a refund takes the next number, like any other receipt');

        $cashier = $this->tokenFor(self::CASHIER);
        $given = $this->call('GET', '/api/v1/sales/' . $refund['sale_id'], $cashier);
        self::assertSame('refund', $given['kind']);
        self::assertSame(-1200, $given['total_millimes']);
        self::assertSame($sale['sale_id'], $given['refunds_sale_id']);
        self::assertSame($line['id'], $given['lines'][0]['refunds_sale_line_id']);

        $paid = $this->call('GET', '/api/v1/sales/' . $sale['sale_id'], $cashier);
        self::assertSame(1, $paid['lines'][0]['refunded_qty'], 'one of the two came back');
        self::assertSame(1200, $paid['lines'][0]['refunded_millimes']);
        self::assertSame(2400, $paid['lines'][0]['net_millimes'], 'and what was paid for it does not change');

        $toomuch = $this->recordSale($this->refundRecord($caisse, 3, $sold, [$this->refundLine(1, $line, 2)]));
        self::assertSame(422, $this->httpStatus());
        self::assertSame('VALIDATION_ERROR', $this->errorCode($toomuch));
        self::assertSame(1, $toomuch['error']['details']['remaining_qty']);
        self::assertSame(1200, $toomuch['error']['details']['remaining_millimes']);
    }

    public function testAVoidBurnsANumberSoTheNextReceiptIsStillTheNextOne(): void
    {
        $caisse = $this->caisse('C1');
        // A record this ledger can never accept: it names a session of no terminal at all.
        $lost = $this->saleRecord($caisse, 1, [$this->line(1, self::EXPRESS, 'Express', 1, 1200)], [
            'session_id' => 'eeeeeeee-eeee-4eee-8eee-999999999999',
        ]);
        $void = ['record' => $lost, 'error_code' => 'NOT_FOUND', 'reason' => 'The session was gone when it arrived'];

        $refused = $this->call('POST', '/api/v1/receipt-voids', $this->tokenFor(self::CASHIER), $void);
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused), 'giving up on a number is the admin’s decision');

        $admin = $this->tokenFor(self::ADMIN);
        $voided = $this->call('POST', '/api/v1/receipt-voids', $admin, $void);
        self::assertSame(201, $this->httpStatus());
        self::assertSame('voided', $voided['status']);
        self::assertSame('C1-1', $voided['receipt_number']);

        $again = $this->call('POST', '/api/v1/receipt-voids', $admin, $void);
        self::assertSame(200, $this->httpStatus());
        self::assertSame('replayed', $again['status']);

        $next = $this->recordSale($this->saleRecord($caisse, 2, [$this->line(1, self::EXPRESS, 'Express', 1, 1200)]));
        self::assertSame(201, $this->httpStatus());
        self::assertSame('C1-2', $next['receipt_number'], 'the burnt number is not reused and none is skipped');
    }

    public function testVoidingWhatTheLedgerTookAfterAllSaysSo(): void
    {
        $caisse = $this->caisse('C1');
        $record = $this->saleRecord($caisse, 1, [$this->line(1, self::EXPRESS, 'Express', 1, 1200)]);
        $sale = $this->recordSale($record);
        self::assertSame(201, $this->httpStatus());

        $answer = $this->call('POST', '/api/v1/receipt-voids', $this->tokenFor(self::ADMIN), [
            'record' => $record,
            'error_code' => 'NETWORK_ERROR',
            'reason' => 'The till gave up waiting for an answer',
        ]);

        self::assertSame(200, $this->httpStatus());
        self::assertSame('recorded', $answer['status'], 'the sale got through; there is nothing to void');
        self::assertSame($sale['receipt_number'], $answer['receipt_number']);
    }

    public function testSomethingCountedLeavesTheShelfWhenItIsSoldAndComesBackWhenItIsGivenBack(): void
    {
        $caisse = $this->caisse('C1');
        $line = $this->line(1, self::WATER, 'Eau minérale 50 cl', 3, 850);
        $sold = $this->saleRecord($caisse, 1, [$line]);
        $this->recordSale($sold);
        self::assertSame(201, $this->httpStatus());

        self::assertSame(117, $this->stockOfWater(), 'three bottles off the shelf');

        $this->recordSale($this->refundRecord($caisse, 2, $sold, [$this->refundLine(1, $line, 1)]));
        self::assertSame(201, $this->httpStatus());
        self::assertSame(118, $this->stockOfWater(), 'and one of them back on it');
    }

    public function testADiscountedLineCarriesWhatWasTakenOffAndWhy(): void
    {
        $caisse = $this->caisse('C1');
        $offered = $this->line(1, self::EXPRESS, 'Express', 1, 1200, [
            'line_discount_millimes' => 200,
            'line_discount_reason' => 'Regular, on the house',
            'allocated_discount_millimes' => 100,
            'net_millimes' => 900,
        ]);
        $full = $this->line(2, self::CROISSANT, 'Croissant', 1, 1200);

        $recorded = $this->recordSale($this->saleRecord($caisse, 1, [$offered, $full], [
            'cart_discount_millimes' => 100,
            'total_millimes' => 2100,
            'payment' => ['method' => 'cash', 'tendered_millimes' => 5000, 'change_millimes' => 2900],
        ]));
        self::assertSame(201, $this->httpStatus(), json_encode($recorded));

        $sale = $this->call('GET', '/api/v1/sales/' . $recorded['sale_id'], $this->tokenFor(self::CASHIER));
        self::assertSame(2100, $sale['total_millimes']);
        self::assertSame(100, $sale['cart_discount_millimes']);
        self::assertSame(2900, $sale['change_millimes']);
        self::assertSame(200, $sale['lines'][0]['line_discount_millimes']);
        self::assertSame('Regular, on the house', $sale['lines'][0]['line_discount_reason']);
        self::assertSame(100, $sale['lines'][0]['allocated_discount_millimes'], 'this line’s share of what came off the bill');
        self::assertSame(900, $sale['lines'][0]['net_millimes']);
    }

    public function testTheListIsNewestFirstAndOfTheTableOrTheTerminalAsked(): void
    {
        $caisse = $this->caisse('C1');
        $item = $this->addToTable(self::TABLE_1, self::EXPRESS, 1);
        $onTheTable = $this->recordSale($this->saleRecord($caisse, 1, [
            $this->line(1, self::EXPRESS, 'Express', 1, 1200, ['open_order_item_id' => $item['item_id']]),
        ], ['table_id' => self::TABLE_1]));
        $overTheCounter = $this->recordSale($this->saleRecord($caisse, 2, [$this->line(1, self::CROISSANT, 'Croissant', 1, 1200)]));
        self::assertSame(201, $this->httpStatus());

        $cashier = $this->tokenFor(self::CASHIER);
        $all = $this->call('GET', '/api/v1/sales', $cashier, null, ['terminal_id' => $caisse['terminal_id']]);
        self::assertSame(
            [$overTheCounter['receipt_number'], $onTheTable['receipt_number']],
            array_column($all, 'receipt_number'),
            'the newest receipt is the one a caisse wants to see first',
        );

        $one = $this->call('GET', '/api/v1/sales', $cashier, null, ['terminal_id' => $caisse['terminal_id'], 'limit' => 1]);
        self::assertSame([$overTheCounter['receipt_number']], array_column($one, 'receipt_number'));

        $atTheTable = $this->call('GET', '/api/v1/sales', $cashier, null, ['table_id' => self::TABLE_1]);
        self::assertSame([$onTheTable['receipt_number']], array_column($atTheTable, 'receipt_number'), 'what was paid at one table');

        $ofTheDrawer = $this->call('GET', '/api/v1/sales', $cashier, null, ['session_id' => $caisse['session_id']]);
        self::assertCount(2, $ofTheDrawer);

        $answer = $this->call('GET', '/api/v1/sales', $cashier, null, ['limit' => '500']);
        self::assertSame(422, $this->httpStatus());
        self::assertSame('limit', $answer['error']['details']['field']);
    }

    public function testAWaiterDoesNotSellAndAnotherCafeCannotUseThisTill(): void
    {
        $caisse = $this->caisse('C1');
        $record = $this->saleRecord($caisse, 1, [$this->line(1, self::EXPRESS, 'Express', 1, 1200)]);

        $refused = $this->recordSale($record, $this->tokenFor(self::WAITER));
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused), 'a waiter carries no register');

        // Every café's terminal codes are its own, and the café next door has no S1.
        $service = $this->register('S1');
        $elsewhere = $this->recordSale(
            $this->saleRecord(['code' => 'S1'] + $service + ['session_id' => $caisse['session_id']], 1, [
                $this->line(1, self::EXPRESS, 'Express', 1, 1200),
            ]),
            $this->tokenFor(self::OTHER_ADMIN),
        );
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($elsewhere));
        self::assertSame('S1', $elsewhere['error']['details']['terminal_code']);
    }

    public function testASaleThatIsNotThereIsNotFound(): void
    {
        $answer = $this->call('GET', '/api/v1/sales/eeeeeeee-eeee-4eee-8eee-999999999999', $this->tokenFor(self::CASHIER));

        self::assertSame(404, $this->httpStatus());
        self::assertSame('NOT_FOUND', $this->errorCode($answer));
    }

    private function stockOfWater(): int
    {
        foreach ($this->call('GET', '/api/v1/products', $this->tokenFor(self::ADMIN)) as $product) {
            if (self::WATER === $product['id']) {
                return $product['stock_qty'];
            }
        }

        self::fail('The water is not on the menu.');
    }

    /** One row with its keys in one order, so a single assertion can say all of it. */
    private function sorted(array $row): array
    {
        ksort($row);

        return $row;
    }
}
