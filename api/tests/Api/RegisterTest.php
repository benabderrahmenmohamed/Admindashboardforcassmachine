<?php

declare(strict_types=1);

namespace App\Tests\Api;

/**
 * The register and its drawer: the device that prints the receipts, and the count at the end of a
 * shift.
 *
 * Two things matter here beyond the arithmetic. A device that was registered and then replaced must
 * not print a number the new one will print too, so every record it sends is turned away by name. And
 * a drawer is counted once: the close is a record, so a till that lost its signal mid-close can send
 * it again and be told the same figures instead of closing twice.
 */
final class RegisterTest extends MoneyTestCase
{
    public function testRegisteringHandsTheDeviceItsCounterAndSupersedesTheOneBefore(): void
    {
        $first = $this->register('C1');

        self::assertSame(['code', 'epoch', 'last_seq', 'open_session', 'terminal_id'], $this->fieldsOf($first));
        self::assertSame('C1', $first['code']);
        self::assertSame(0, $first['last_seq'], 'a terminal that has printed nothing starts at nothing');
        self::assertNull($first['open_session'], 'and has no drawer open on it');

        $again = $this->register('C1');
        self::assertSame($first['terminal_id'], $again['terminal_id'], 'the same terminal, on another device');
        self::assertSame($first['epoch'] + 1, $again['epoch'], 'and the device before it is now out of date');

        $refused = $this->call('POST', '/api/v1/terminals/C1/registrations', $this->tokenFor(self::CASHIER));
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused), 'which device is which terminal is the admin’s to say');
    }

    public function testATerminalCodeThatIsNotOneIsRefusedWithTheFieldNamed(): void
    {
        $answer = $this->call('POST', '/api/v1/terminals/TOOLONGCODE/registrations', $this->tokenFor(self::ADMIN));

        self::assertSame(422, $this->httpStatus());
        self::assertSame('VALIDATION_ERROR', $this->errorCode($answer));
        self::assertSame('code', $answer['error']['details']['field']);
    }

    public function testADrawerOpensOnceAndTheSameRecordAnswersTwice(): void
    {
        $terminal = $this->register('C1');
        $record = $this->openRecord($terminal, 25000);

        $opened = $this->call('POST', '/api/v1/cash-sessions', $this->tokenFor(self::CASHIER), $record);
        self::assertSame(201, $this->httpStatus());
        self::assertSame('created', $opened['status']);
        self::assertSame($record['id'], $opened['session_id'], 'the record names the session it opens');
        self::assertSame(25000, $opened['session']['opening_float_millimes']);
        self::assertSame(self::CASHIER_ID, $opened['session']['opened_by']);
        self::assertSame('C1', $opened['session']['terminal_code']);
        self::assertNull($opened['session']['closed_at']);
        self::assertNull($opened['session']['z_report'], 'a drawer that is still open has no report of its own');

        $again = $this->call('POST', '/api/v1/cash-sessions', $this->tokenFor(self::CASHIER), $record);
        self::assertSame(200, $this->httpStatus());
        self::assertSame('replayed', $again['status']);
        self::assertSame($opened['session_id'], $again['session_id']);

        $second = $this->call('POST', '/api/v1/cash-sessions', $this->tokenFor(self::CASHIER), $this->openRecord($terminal));
        self::assertSame(409, $this->httpStatus());
        self::assertSame('SESSION_ALREADY_OPEN', $this->errorCode($second));
        self::assertSame($opened['session_id'], $second['error']['details']['open_session_id']);
    }

    public function testARecordFromAReplacedDeviceIsTurnedAwayByName(): void
    {
        $old = $this->register('C1');
        $new = $this->register('C1');

        $answer = $this->call('POST', '/api/v1/cash-sessions', $this->tokenFor(self::CASHIER), $this->openRecord($old));

        self::assertSame(409, $this->httpStatus());
        self::assertSame('TERMINAL_SUPERSEDED', $this->errorCode($answer));
        self::assertSame('C1', $answer['error']['details']['terminal_code']);
        self::assertSame($new['epoch'], $answer['error']['details']['current_epoch'], 'and told which registration is current');
    }

    public function testTheDrawersOfATerminalAreItsOwnAndAtMostOneIsOpen(): void
    {
        $caisse = $this->caisse('C1');
        $elsewhere = $this->caisse('S1');
        $cashier = $this->tokenFor(self::CASHIER);

        $open = $this->call('GET', '/api/v1/cash-sessions', $cashier, null, [
            'terminal_id' => $caisse['terminal_id'],
            'status' => 'open',
        ]);
        self::assertSame(200, $this->httpStatus());
        self::assertCount(1, $open);
        self::assertSame($caisse['session_id'], $open[0]['id']);
        self::assertSame([
            'closed_at', 'closed_by', 'closing_counted_millimes', 'force_close_reason', 'id',
            'opened_at', 'opened_by', 'opening_float_millimes', 'terminal_code', 'terminal_id', 'z_report',
        ], $this->fieldsOf($open[0]));

        self::assertSame([], $this->call('GET', '/api/v1/cash-sessions', $cashier, null, [
            'terminal_id' => $caisse['terminal_id'],
            'status' => 'closed',
        ]), 'nothing has been closed on this terminal yet');

        $theirs = $this->call('GET', '/api/v1/cash-sessions', $cashier, null, ['terminal_id' => $elsewhere['terminal_id']]);
        self::assertSame([$elsewhere['session_id']], array_column($theirs, 'id'), 'one terminal never lists another’s drawers');

        $answer = $this->call('GET', '/api/v1/cash-sessions', $cashier, null, ['status' => 'open']);
        self::assertSame(422, $this->httpStatus());
        self::assertSame('terminal_id', $answer['error']['details']['field'], 'the sessions of which terminal?');
    }

    public function testClosingCountsTheDrawerAndOnlyTheTerminalThatOwnsItMay(): void
    {
        $caisse = $this->caisse('C1', 20000);
        $elsewhere = $this->register('S1');
        $this->recordSale($this->saleRecord($caisse, 1, [$this->line(1, self::EXPRESS, 'Express', 2, 1200)]));
        self::assertSame(201, $this->httpStatus());

        $refused = $this->call('POST', '/api/v1/cash-sessions/' . $caisse['session_id'] . '/closures', $this->tokenFor(self::CASHIER), $this->closeRecord([
            'session_id' => $caisse['session_id'],
            'code' => $elsewhere['code'],
            'epoch' => $elsewhere['epoch'],
        ], 22400));
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused), 'the till that opened a drawer is the one that counts it');

        $record = $this->closeRecord($caisse, 22400);
        $closed = $this->call('POST', '/api/v1/cash-sessions/' . $caisse['session_id'] . '/closures', $this->tokenFor(self::CASHIER), $record);
        self::assertSame(201, $this->httpStatus());
        self::assertSame('created', $closed['status']);
        self::assertSame([
            'by_method' => [
                'card' => ['net_millimes' => 0, 'refunds_millimes' => 0, 'sales_millimes' => 0],
                'cash' => ['net_millimes' => 2400, 'refunds_millimes' => 0, 'sales_millimes' => 2400],
            ],
            'counted_cash_millimes' => 22400,
            'expected_cash_millimes' => 22400,
            'gross_millimes' => 2400,
            'net_millimes' => 2400,
            'opening_float_millimes' => 20000,
            'refunds_count' => 0,
            'refunds_millimes' => 0,
            'sales_count' => 1,
            'session_id' => $caisse['session_id'],
            'variance_millimes' => 0,
            'voids_count' => 0,
        ], $this->sorted($closed['z_report']));

        $again = $this->call('POST', '/api/v1/cash-sessions/' . $caisse['session_id'] . '/closures', $this->tokenFor(self::CASHIER), $record);
        self::assertSame(200, $this->httpStatus());
        self::assertSame('replayed', $again['status']);
        self::assertSame($closed['z_report'], $again['z_report'], 'a replay answers the figures of the close, not of now');

        $third = $this->call('POST', '/api/v1/cash-sessions/' . $caisse['session_id'] . '/closures', $this->tokenFor(self::CASHIER), $this->closeRecord($caisse, 30000));
        self::assertSame(409, $this->httpStatus());
        self::assertSame('SESSION_CLOSED', $this->errorCode($third));
    }

    public function testTheReportRunsWhileTheDrawerIsOpenAndIsKeptAsItWasWhenItClosed(): void
    {
        $caisse = $this->caisse('C1', 20000);
        $cashier = $this->tokenFor(self::CASHIER);
        $this->recordSale($this->saleRecord($caisse, 1, [$this->line(1, self::EXPRESS, 'Express', 2, 1200)]));
        $card = $this->saleRecord($caisse, 2, [$this->line(1, self::CROISSANT, 'Croissant', 1, 1200)]);
        $this->recordSale(['payment' => ['method' => 'card', 'tendered_millimes' => 1200, 'change_millimes' => 0]] + $card);
        self::assertSame(201, $this->httpStatus());

        $running = $this->call('GET', '/api/v1/cash-sessions/' . $caisse['session_id'] . '/z-report', $cashier);
        self::assertSame(200, $this->httpStatus());
        self::assertSame(2, $running['sales_count']);
        self::assertSame(3600, $running['gross_millimes']);
        self::assertSame(22400, $running['expected_cash_millimes'], 'the float and the cash, and not the card');
        self::assertSame(1200, $running['by_method']['card']['net_millimes']);
        self::assertNull($running['counted_cash_millimes'], 'nothing has been counted yet');
        self::assertNull($running['variance_millimes']);

        // Five hundred millimes short.
        $this->call('POST', '/api/v1/cash-sessions/' . $caisse['session_id'] . '/closures', $cashier, $this->closeRecord($caisse, 21900));
        self::assertSame(201, $this->httpStatus());

        $kept = $this->call('GET', '/api/v1/cash-sessions/' . $caisse['session_id'] . '/z-report', $cashier);
        self::assertSame(21900, $kept['counted_cash_millimes']);
        self::assertSame(-500, $kept['variance_millimes']);
        self::assertSame(22400, $kept['expected_cash_millimes']);

        $listed = $this->call('GET', '/api/v1/cash-sessions', $cashier, null, ['terminal_id' => $caisse['terminal_id']]);
        self::assertSame($kept, $listed[0]['z_report'], 'the closed drawer carries the report it was closed with');
        self::assertSame(21900, $listed[0]['closing_counted_millimes']);
    }

    public function testAReportOfADrawerThisCafeDoesNotHaveIsNotFound(): void
    {
        $answer = $this->call('GET', '/api/v1/cash-sessions/eeeeeeee-eeee-4eee-8eee-999999999999/z-report', $this->tokenFor(self::CASHIER));

        self::assertSame(404, $this->httpStatus());
        self::assertSame('NOT_FOUND', $this->errorCode($answer));
    }

    /** @return list<string> the answer's fields, as a set: jsonb keeps no order of its own. */
    private function fieldsOf(array $row): array
    {
        $fields = array_keys($row);
        sort($fields);

        return $fields;
    }

    /** A report with its keys in one order, so a single assertion can say all of it. */
    private function sorted(array $report): array
    {
        ksort($report);

        return array_map(static function (mixed $value): mixed {
            if (!is_array($value)) {
                return $value;
            }
            ksort($value);

            return array_map(static function (mixed $inner): mixed {
                if (is_array($inner)) {
                    ksort($inner);
                }

                return $inner;
            }, $value);
        }, $report);
    }
}
