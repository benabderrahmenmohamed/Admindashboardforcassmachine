<?php

declare(strict_types=1);

namespace App\Tests\Database;

use App\Demo\DemoSeeder;
use Doctrine\DBAL\Exception\DriverException;

/**
 * The guard under the API: whatever a controller forgets, the database shows a member only their own
 * café, and refuses every hand that reaches for the ledger. Supabase enforced this through the token
 * it read; here the API puts the member's id on the connection and the same policies do the rest.
 */
final class RowLevelSecurityTest extends DatabaseTestCase
{
    private const WAITER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
    private const CASHIER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    private const OTHER_ADMIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

    public function testAMemberReadsTheirOwnCafeAndNobodyElseIsVisible(): void
    {
        $this->actAs(self::WAITER);
        self::assertSame(12, $this->rowsIn('products'), 'the demo café has twelve things on the menu');
        self::assertSame(8, $this->rowsIn('dining_tables'));
        self::assertSame(
            'Café de la Marsa',
            $this->app->fetchOne('select name from public.shops'),
            'and the only shop it can read is its own',
        );

        $this->actAs(self::OTHER_ADMIN);
        self::assertSame(2, $this->rowsIn('products'), 'the other shop sees its own two, never the café’s');
        self::assertSame(1, $this->rowsIn('dining_tables'));
    }

    public function testNobodySignedInReadsNothingAtAll(): void
    {
        $this->actAs(null);

        self::assertSame(0, $this->rowsIn('products'));
        self::assertSame(0, $this->rowsIn('shops'));
        self::assertSame(0, $this->rowsIn('sales'));
        self::assertNull(
            $this->app->fetchOne('select private.current_user_id()'),
            'an empty setting is nobody, not a member whose id happens to be blank',
        );
    }

    public function testTheMemberOnTheConnectionIsTheOneTheApiPutThere(): void
    {
        $this->actAs(self::CASHIER);

        self::assertSame(self::CASHIER, $this->app->fetchOne('select private.current_user_id()'));
        self::assertSame(DemoSeeder::SHOP, $this->app->fetchOne('select private.current_shop_id()'));
    }

    public function testTheRoleTheApiConnectsAsCannotWriteTheLedger(): void
    {
        $this->actAs(self::CASHIER);

        foreach (['sales', 'sale_lines', 'stock_movements', 'receipt_voids'] as $table) {
            foreach (['insert', 'update', 'delete', 'truncate'] as $write) {
                self::assertFalse(
                    (bool) $this->app->fetchOne('select has_table_privilege(?, ?, ?)', ['cafe_app', "public.{$table}", $write]),
                    "the API's role must not be able to {$write} {$table}: the ledger is written by its functions alone",
                );
            }
            self::assertTrue(
                (bool) $this->app->fetchOne('select has_table_privilege(?, ?, ?)', ['cafe_app', "public.{$table}", 'select']),
                "but it reads {$table}, because the screens show what was recorded",
            );
        }
    }

    private function rowsIn(string $table): int
    {
        return (int) $this->app->fetchOne("select count(*) from public.{$table}");
    }
}
