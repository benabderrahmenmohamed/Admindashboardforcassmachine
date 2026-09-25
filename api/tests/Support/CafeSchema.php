<?php

declare(strict_types=1);

namespace App\Tests\Support;

use App\Demo\DemoSeeder;
use Doctrine\DBAL\Connection;

/**
 * The café a test starts from: the schema applied once to the test database, and the demo shop in
 * it. Tests that write clean up after themselves — nothing here empties the database between tests,
 * because most of them only read, and the ledger cannot be emptied anyway.
 *
 * The files are the migrations' own (migrations/sql), run here directly rather than through Doctrine:
 * a test needs the schema, not the record of how it got there. Each one is named with something it
 * creates, so a database that already has it is left alone and a new migration is one line.
 */
trait CafeSchema
{
    private const SCHEMA = [
        '0001_schema.sql' => 'public.shops',
        '0002_changes.sql' => 'private.shop_changes',
    ];

    protected function applySchemaOnce(Connection $admin): void
    {
        foreach (self::SCHEMA as $file => $creates) {
            if (null !== $admin->fetchOne('select to_regclass(?)', [$creates])) {
                continue;
            }

            $sql = file_get_contents(\dirname(__DIR__, 2) . '/migrations/sql/' . $file);
            self::assertIsString($sql, "The schema file {$file} must be readable.");
            $admin->getNativeConnection()->exec($sql);
        }

        $seeder = new DemoSeeder();
        if (!$seeder->isSeeded($admin)) {
            $seeder->seed($admin);
        }
    }
}
