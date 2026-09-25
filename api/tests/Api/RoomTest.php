<?php

declare(strict_types=1);

namespace App\Tests\Api;

/**
 * The room over HTTP: the tables, the board the floor reads, the five order records, the kitchen's
 * tickets and the admin's report of what was taken back off.
 *
 * Every write here is a record a device wrote, possibly hours ago on a phone with no signal. What
 * these tests hold the server to is what that costs: the same record twice is one line and two
 * answers, a record names its own author, and a refusal says which code it is so a queue knows
 * whether to wait, stop, or give up on that one record.
 */
final class RoomTest extends ApiTestCase
{
    private const TABLE_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01';
    private const TABLE_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02';
    private const COMPTOIR = 'dddddddd-dddd-4ddd-8ddd-dddddddddd08';
    private const EXPRESS = '55555555-5555-4555-8555-555555555505';
    private const CROISSANT = '55555555-5555-4555-8555-555555555510';
    private const OTHER_TABLE = 'dddddddd-dddd-4ddd-8ddd-ddddddddddb1';
    private const OTHER_PRODUCT = '66666666-6666-4666-8666-666666666601';
    private const WAITER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
    private const CASHIER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

    public function testAFreeTableIsOnTheBoardWithNothingOnIt(): void
    {
        $board = $this->call('GET', '/api/v1/table-board', $this->tokenFor(self::WAITER));

        self::assertSame(200, $this->httpStatus());
        self::assertCount(8, $board, 'every table in service has a tile, free or not');
        self::assertSame(['Table 1', 'Table 2', 'Table 3', 'Table 4'], array_map(
            static fn (array $tile): string => $tile['table']['name'],
            array_slice($board, 0, 4),
        ), "the board is in the admin's order");
        self::assertSame([
            'active_count' => 0,
            'due_millimes' => 0,
            'opened_at' => null,
            'order_id' => null,
            'unpaid_count' => 0,
            'unsent_count' => 0,
        ], $this->withoutTable($board[0]));

        self::assertNull(
            $this->openOrderOf(self::TABLE_1, $this->tokenFor(self::WAITER)),
            'a free table has no open order, and the API says so with null rather than a 404',
        );
    }

    public function testAnItemPutOnATableShowsOnTheBoardAndInTheOrder(): void
    {
        $token = $this->tokenFor(self::WAITER);
        $added = $this->add($token, self::TABLE_1, self::EXPRESS, 2);

        self::assertSame(201, $this->httpStatus());
        self::assertSame('created', $added['status']);

        $order = $this->openOrderOf(self::TABLE_1, $token);
        self::assertSame($added['order_id'], $order['id']);
        self::assertSame('open', $order['status']);
        self::assertCount(1, $order['items']);
        $item = $order['items'][0];
        self::assertSame($added['item_id'], $item['id']);
        self::assertSame('Express', $item['name_snapshot'], 'the name is copied when the item is added');
        self::assertSame(1200, $item['unit_price_millimes']);
        self::assertSame(2, $item['qty']);
        self::assertSame(self::WAITER_ID, $item['added_by']);
        self::assertNull($item['sent_at']);

        $tile = $this->tileOf($this->call('GET', '/api/v1/table-board', $token), self::TABLE_1);
        self::assertSame([
            'active_count' => 1,
            'due_millimes' => 2400,
            'opened_at' => $order['opened_at'],
            'order_id' => $order['id'],
            'unpaid_count' => 1,
            'unsent_count' => 1,
        ], $this->withoutTable($tile));
    }

    public function testTheSameRecordTwiceIsOneItemAndTwoAnswers(): void
    {
        $token = $this->tokenFor(self::WAITER);
        $record = $this->record(['table_id' => self::TABLE_1, 'product_id' => self::EXPRESS, 'qty' => 1, 'note' => '']);

        $first = $this->call('POST', '/api/v1/order-items', $token, $record);
        self::assertSame(201, $this->httpStatus());

        $again = $this->call('POST', '/api/v1/order-items', $token, $record);
        self::assertSame(200, $this->httpStatus(), 'a record the server has already stored is not a new one');
        self::assertSame('replayed', $again['status']);
        self::assertSame($first['item_id'], $again['item_id']);
        self::assertSame($first['order_id'], $again['order_id']);

        self::assertCount(1, $this->openOrderOf(self::TABLE_1, $token)['items'], 'a phone that sends twice is charged once');
    }

    public function testAnotherRecordUnderTheSameIdIsARefusalAndNotAReplay(): void
    {
        $token = $this->tokenFor(self::WAITER);
        $record = $this->record(['table_id' => self::TABLE_1, 'product_id' => self::EXPRESS, 'qty' => 1, 'note' => '']);
        $this->call('POST', '/api/v1/order-items', $token, $record);

        $other = $this->call('POST', '/api/v1/order-items', $token, [
            'qty' => 9,
            'payload_hash' => str_repeat('f', 64),
        ] + $record);

        self::assertSame(409, $this->httpStatus());
        self::assertSame('IDEMPOTENCY_CONFLICT', $this->errorCode($other));
        self::assertSame($record['id'], $other['error']['details']['id']);
    }

    public function testARetiredTableTakesNothingNewAndLeavesTheBoardButStaysInTheList(): void
    {
        $admin = $this->tokenFor(self::ADMIN);
        $this->call('PUT', '/api/v1/dining-tables/' . self::COMPTOIR, $admin, [
            'name' => 'Comptoir',
            'sort_order' => 8,
            'is_active' => false,
        ]);
        self::assertSame(200, $this->httpStatus());

        $refused = $this->add($this->tokenFor(self::WAITER), self::COMPTOIR, self::EXPRESS, 1);
        self::assertSame(409, $this->httpStatus());
        self::assertSame('TABLE_INACTIVE', $this->errorCode($refused));

        $board = $this->call('GET', '/api/v1/table-board', $admin);
        self::assertCount(7, $board);
        self::assertSame([], array_filter($board, static fn (array $tile): bool => self::COMPTOIR === $tile['table']['id']));

        $tables = $this->call('GET', '/api/v1/dining-tables', $admin);
        self::assertCount(8, $tables, 'a table is retired, never deleted - old sales keep its name');
        self::assertFalse($this->tableIn($tables, self::COMPTOIR)['is_active']);
    }

    public function testTheTablesAreTheAdminsToNameAndNobodyElsesToChange(): void
    {
        $refused = $this->call('POST', '/api/v1/dining-tables', $this->tokenFor(self::WAITER), [
            'name' => 'Terrasse 4',
            'sort_order' => 9,
            'is_active' => true,
        ]);
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused));

        $created = $this->call('POST', '/api/v1/dining-tables', $this->tokenFor(self::ADMIN), [
            'name' => 'Terrasse 4',
            'sort_order' => 9,
            'is_active' => true,
        ]);
        self::assertSame(201, $this->httpStatus());
        self::assertSame(['id', 'is_active', 'name', 'sort_order'], $this->fieldsOf($created));
        self::assertSame('Terrasse 4', $created['name']);

        $taken = $this->call('POST', '/api/v1/dining-tables', $this->tokenFor(self::ADMIN), [
            'name' => 'Table 1',
            'sort_order' => 10,
            'is_active' => true,
        ]);
        self::assertSame(422, $this->httpStatus());
        self::assertSame('VALIDATION_ERROR', $this->errorCode($taken));
        self::assertSame('name', $taken['error']['details']['field']);
    }

    public function testOneSendIsOneTicketAndPreparingTakesTheLineOffIt(): void
    {
        $waiter = $this->tokenFor(self::WAITER);
        $this->add($waiter, self::TABLE_2, self::EXPRESS, 1);
        $this->add($waiter, self::TABLE_2, self::CROISSANT, 2);

        $sentAt = $this->moment('-10 minutes');
        $sent = $this->call('POST', '/api/v1/dining-tables/' . self::TABLE_2 . '/sends', $waiter, $this->record([
            'table_id' => self::TABLE_2,
        ], $sentAt));
        self::assertSame(201, $this->httpStatus());
        self::assertSame(2, $sent['affected'], 'one send is every unsent item of the table');

        // Added after the send, so the kitchen has not been told about it and it is on no ticket.
        $this->add($waiter, self::TABLE_2, self::CROISSANT, 1);

        $kitchen = $this->tokenFor(self::KITCHEN);
        $tickets = $this->call('GET', '/api/v1/kitchen-tickets', $kitchen);
        self::assertCount(1, $tickets);
        self::assertSame(self::TABLE_2, $tickets[0]['table_id']);
        self::assertSame('Table 2', $tickets[0]['table_name']);
        self::assertSame($sentAt, $tickets[0]['sent_at'], 'the stamp is the moment the device wrote, to the letter');
        self::assertSame(['Express', 'Croissant'], array_column($tickets[0]['items'], 'name_snapshot'));

        $prepared = $this->call('POST', '/api/v1/order-items/' . $tickets[0]['items'][0]['id'] . '/preparations', $kitchen, $this->record([
            'item_id' => $tickets[0]['items'][0]['id'],
        ]));
        self::assertSame(201, $this->httpStatus());
        self::assertSame(1, $prepared['affected']);

        $left = $this->call('GET', '/api/v1/kitchen-tickets', $kitchen);
        self::assertSame(['Croissant'], array_column($left[0]['items'], 'name_snapshot'), 'what is made leaves the card');
    }

    public function testTheKitchenPreparesAndTheFloorSends(): void
    {
        $waiter = $this->tokenFor(self::WAITER);
        $added = $this->add($waiter, self::TABLE_1, self::EXPRESS, 1);

        $refused = $this->call('POST', '/api/v1/order-items/' . $added['item_id'] . '/preparations', $waiter, $this->record([
            'item_id' => $added['item_id'],
        ]));
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused), 'a waiter does not decide that a coffee is made');

        $refused = $this->call('POST', '/api/v1/dining-tables/' . self::TABLE_1 . '/sends', $this->tokenFor(self::KITCHEN), $this->record([
            'table_id' => self::TABLE_1,
        ]));
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused), 'and the kitchen does not order for the guests');
    }

    public function testARemovalAfterTheSendIsOnTheAdminsReportWithBothNamesOnIt(): void
    {
        $waiter = $this->tokenFor(self::WAITER);
        $added = $this->add($waiter, self::TABLE_1, self::EXPRESS, 1);
        $this->call('POST', '/api/v1/dining-tables/' . self::TABLE_1 . '/sends', $waiter, $this->record(['table_id' => self::TABLE_1]));

        // The waiter's phone was passed to the caisse, so the record names the waiter and the login
        // that sent it is the cashier's.
        $removed = $this->call('POST', '/api/v1/order-items/' . $added['item_id'] . '/removals', $this->tokenFor(self::CASHIER), $this->record([
            'item_id' => $added['item_id'],
            'reason' => 'Sent back, cold',
            'actor_user_id' => self::WAITER_ID,
        ]));
        self::assertSame(201, $this->httpStatus());
        self::assertSame(1, $removed['affected']);

        $report = $this->call('GET', '/api/v1/reports/removed-after-sent-items', $this->tokenFor(self::ADMIN), null, [
            'from' => $this->moment('-1 hour'),
            'to' => $this->moment('+1 hour'),
        ]);
        self::assertSame(200, $this->httpStatus());
        self::assertCount(1, $report);
        self::assertSame([
            'item_id' => $added['item_id'],
            'product_name' => 'Express',
            'qty' => 1,
            'removed_by' => self::WAITER_ID,
            'removed_by_name' => 'Demo Waiter',
            'removed_reason' => 'Sent back, cold',
            'submitted_by' => self::CASHIER_ID,
            'submitted_by_name' => 'Demo Cashier',
            'table_name' => 'Table 1',
            'unit_price_millimes' => 1200,
        ], $this->without($report[0], ['sent_at', 'removed_at']));

        $refused = $this->call('GET', '/api/v1/reports/removed-after-sent-items', $waiter, null, [
            'from' => $this->moment('-1 hour'),
            'to' => $this->moment('+1 hour'),
        ]);
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused), 'the report is the admin’s to read');
    }

    public function testAnItemOffTheTableIsStillOnTheOrderAndOffTheBoard(): void
    {
        $waiter = $this->tokenFor(self::WAITER);
        $added = $this->add($waiter, self::TABLE_1, self::EXPRESS, 1);
        $this->call('POST', '/api/v1/order-items/' . $added['item_id'] . '/removals', $waiter, $this->record([
            'item_id' => $added['item_id'],
            'reason' => 'Wrong table',
        ]));
        self::assertSame(201, $this->httpStatus());

        $order = $this->openOrderOf(self::TABLE_1, $waiter);
        self::assertCount(1, $order['items'], 'the row stays: the report of what was removed is made of it');
        self::assertNotNull($order['items'][0]['removed_at']);
        self::assertSame(self::WAITER_ID, $order['items'][0]['removed_by']);
        self::assertSame('Wrong table', $order['items'][0]['removed_reason']);

        $tile = $this->tileOf($this->call('GET', '/api/v1/table-board', $waiter), self::TABLE_1);
        self::assertSame(0, $tile['active_count']);
        self::assertSame(0, $tile['due_millimes'], 'and the guest owes nothing for it');
    }

    public function testACancelledOrderLeavesTheTableFreeAndTheKitchenWithNothingToMake(): void
    {
        $waiter = $this->tokenFor(self::WAITER);
        $this->add($waiter, self::TABLE_1, self::EXPRESS, 1);
        $this->call('POST', '/api/v1/dining-tables/' . self::TABLE_1 . '/sends', $waiter, $this->record(['table_id' => self::TABLE_1]));

        $refused = $this->call('POST', '/api/v1/dining-tables/' . self::TABLE_1 . '/cancellations', $waiter, $this->record([
            'table_id' => self::TABLE_1,
            'reason' => 'The guests left',
        ]));
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused), 'a waiter cannot wipe a table clean');

        $cancelled = $this->call('POST', '/api/v1/dining-tables/' . self::TABLE_1 . '/cancellations', $this->tokenFor(self::CASHIER), $this->record([
            'table_id' => self::TABLE_1,
            'reason' => 'The guests left',
        ]));
        self::assertSame(201, $this->httpStatus());
        self::assertSame(1, $cancelled['affected']);

        self::assertNull($this->openOrderOf(self::TABLE_1, $waiter), 'the table is free again');
        self::assertSame([], $this->call('GET', '/api/v1/kitchen-tickets', $this->tokenFor(self::KITCHEN)));
    }

    public function testAPollSaysWhatToReadAgainAndThenGoesQuiet(): void
    {
        $waiter = $this->tokenFor(self::WAITER);

        $start = $this->call('GET', '/api/v1/open-orders', $waiter);
        self::assertSame([], $start['topics'], 'the first poll is a starting point: what happened before is in what was read');
        self::assertNotSame('', $start['cursor']);

        $this->add($waiter, self::TABLE_1, self::EXPRESS, 1);

        $changed = $this->call('GET', '/api/v1/open-orders', $waiter, null, ['since' => $start['cursor']]);
        self::assertSame(['open_order_items', 'open_orders'], $changed['topics'], 'a table taking its first order is both');

        $quiet = $this->call('GET', '/api/v1/open-orders', $waiter, null, ['since' => $changed['cursor']]);
        self::assertSame([], $quiet['topics'], 'and nothing has happened since');
    }

    public function testAPollHearsNothingOfAnotherCafesRoom(): void
    {
        $waiter = $this->tokenFor(self::WAITER);
        $elsewhere = $this->tokenFor(self::OTHER_ADMIN);

        $here = $this->call('GET', '/api/v1/open-orders', $waiter);
        $there = $this->call('GET', '/api/v1/open-orders', $elsewhere);

        $this->add($elsewhere, self::OTHER_TABLE, self::OTHER_PRODUCT, 1);

        self::assertSame(
            [],
            $this->call('GET', '/api/v1/open-orders', $waiter, null, ['since' => $here['cursor']])['topics'],
            'a busy evening in another café is not this one’s business',
        );
        self::assertSame(
            ['open_order_items', 'open_orders'],
            $this->call('GET', '/api/v1/open-orders', $elsewhere, null, ['since' => $there['cursor']])['topics'],
            'and the café it happened in does hear it, so the silence above is the policy and not an empty log',
        );
    }

    public function testACursorThatIsNotOneIsTheClientsMistake(): void
    {
        $answer = $this->call('GET', '/api/v1/open-orders', $this->tokenFor(self::WAITER), null, ['since' => 'yesterday-ish']);

        self::assertSame(422, $this->httpStatus());
        self::assertSame('VALIDATION_ERROR', $this->errorCode($answer));
        self::assertSame('since', $answer['error']['details']['field']);
    }

    public function testATableOfAnotherCafeTakesNothingFromThisOne(): void
    {
        $refused = $this->add($this->tokenFor(self::OTHER_ADMIN), self::TABLE_1, self::EXPRESS, 1);

        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused));
        self::assertSame(self::TABLE_1, $refused['error']['details']['table_id']);
    }

    public function testARecordSentToTheWrongAddressIsRefusedBeforeTheDatabaseSeesIt(): void
    {
        $waiter = $this->tokenFor(self::WAITER);
        $added = $this->add($waiter, self::TABLE_1, self::EXPRESS, 1);

        $answer = $this->call('POST', '/api/v1/order-items/' . self::EXPRESS . '/removals', $waiter, $this->record([
            'item_id' => $added['item_id'],
            'reason' => 'Changed their mind',
        ]));

        self::assertSame(422, $this->httpStatus());
        self::assertSame('VALIDATION_ERROR', $this->errorCode($answer));
        self::assertSame('item_id', $answer['error']['details']['field']);
    }

    public function testARecordWithNoReasonIsRefusedWithTheFieldNamed(): void
    {
        $waiter = $this->tokenFor(self::WAITER);
        $added = $this->add($waiter, self::TABLE_1, self::EXPRESS, 1);

        $answer = $this->call('POST', '/api/v1/order-items/' . $added['item_id'] . '/removals', $waiter, $this->record([
            'item_id' => $added['item_id'],
            'reason' => '  ',
        ]));

        self::assertSame(422, $this->httpStatus());
        self::assertSame('VALIDATION_ERROR', $this->errorCode($answer));
        self::assertSame('reason', $answer['error']['details']['field']);
    }

    /** An add, as a device sends it. */
    private function add(string $token, string $tableId, string $productId, int $qty): array
    {
        return $this->call('POST', '/api/v1/order-items', $token, $this->record([
            'table_id' => $tableId,
            'product_id' => $productId,
            'qty' => $qty,
            'note' => '',
        ]));
    }

    private function openOrderOf(string $tableId, string $token): ?array
    {
        $this->call('GET', '/api/v1/dining-tables/' . $tableId . '/open-order', $token);
        self::assertSame(200, $this->httpStatus());

        return $this->answer();
    }

    private function tileOf(array $board, string $tableId): array
    {
        foreach ($board as $tile) {
            if ($tile['table']['id'] === $tableId) {
                return $tile;
            }
        }

        self::fail("No tile for table {$tableId} on the board.");
    }

    private function tableIn(array $tables, string $tableId): array
    {
        foreach ($tables as $table) {
            if ($table['id'] === $tableId) {
                return $table;
            }
        }

        self::fail("Table {$tableId} is not in the list.");
    }

    /** A tile without its table, so one assertion can say everything the tile counts. */
    private function withoutTable(array $tile): array
    {
        return $this->without($tile, ['table']);
    }

    /** @param list<string> $fields the ones a test cannot know, such as a stamp the server made */
    private function without(array $row, array $fields): array
    {
        $rest = array_diff_key($row, array_flip($fields));
        ksort($rest);

        return $rest;
    }

    /** @return list<string> the answer's fields, as a set: jsonb keeps no order of its own. */
    private function fieldsOf(array $row): array
    {
        $fields = array_keys($row);
        sort($fields);

        return $fields;
    }
}
